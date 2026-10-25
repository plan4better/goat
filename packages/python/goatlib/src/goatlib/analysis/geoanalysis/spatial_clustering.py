"""
Clustering using Kmean or balanced zones (in count or field value) using Genetic Algorithm
"""

import logging
from pathlib import Path
from typing import Self

import numpy as np

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.base import GeometryType
from goatlib.analysis.schemas.clustering import ClusteringParams, ClusterType
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)


class ClusteringZones(AnalysisTool):
    """
    Clustering to n Zones.
    - K-means Clustering
    - Genetic algorithm implementation for balanced spatial clustering, with potential field based size and compactness constraint
    In the Genetic Algorithm implementation, all constraints are soft. The maximum distance is not a hard threshold but rather a penalty function that encourages more compact zones.

    The algorithm:
    1. Build spatial neighbor graph for contiguity constraints
    2. Create initial population (K-means seeded + mutations + random individuals)
    3. For each generation:
       - Calculate fitness score based on zone size variance
       - Select top individuals as parents (lowest fitness = best)
       - Apply crossover and mutation to create offspring + add random "aliens" for diversity
       - Apply elitism to preserve best solutions
    4. Return the solution with lowest fitness score after convergence
    """

    def __init__(
        self: Self,
        db_path: Path | None = None,
        population_size: int = 50,
        n_generations: int = 50,
        mutation_rate: float = 0.1,
        crossover_rate: float = 0.7,
        equal_size_weight: float = 1.0,
    ) -> None:
        """Initialize the balanced zone clustering tool.

        Args:
            db_path: Path to DuckDB database.
            population_size: Number of individuals in each generation.
            n_generations: Maximum number of generations to evolve.
            mutation_rate: Probability of mutation (also controls alien introduction).
            crossover_rate: Probability of crossover between parents.
            equal_size_weight: Weight for equal-size fitness component.
        """
        super().__init__(db_path=db_path)
        self.population_size = population_size
        self.n_generations = n_generations
        self.mutation_rate = mutation_rate
        self.crossover_rate = crossover_rate
        self.equal_size_weight = equal_size_weight

    def _run_implementation(
        self: Self, params: ClusteringParams
    ) -> list[tuple[Path, DatasetMetadata]]:
        input_meta, input_view = self.import_input(params.input_path, "input_data")
        input_geom = input_meta.geometry_column

        if not input_geom:
            raise ValueError("The input layer has no geometry column.")

        # Validate that input contains point geometries
        self.validate_geometry_types(
            input_view,
            input_geom,
            [GeometryType.point],
            "input",
        )

        # Get CRS from source metadata
        crs = input_meta.crs
        if crs:
            crs_str = crs.to_string()
        else:
            crs_str = "EPSG:4326"
            logger.warning(
                "Could not detect CRS for %s, using fallback: %s",
                params.input_path,
                crs_str,
            )

        k = params.nb_cluster
        use_compactness = params.use_compactness
        if use_compactness:
            max_distance = params.max_distance
            self.compactness_weight = params.compactness_weight
        else:
            self.compactness_weight = 0.0
            max_distance = None

        # Determine weight expression: use numeric field if specified, otherwise 1 per point
        has_field_weights = params.size_method == "field" and params.size_field
        if has_field_weights:
            weight_expr = f'CAST("{params.size_field}" AS DOUBLE)'
        else:
            weight_expr = "1"

        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE features_metric AS
            SELECT
                ROW_NUMBER() OVER () - 1 as feature_id,
                *,
                ST_X({input_geom}) AS lon,
                ST_Y({input_geom}) AS lat,
                {weight_expr} AS weight,
                ST_X(ST_Transform({input_geom}, '{crs_str}', 'EPSG:3857', always_xy := true)) AS x,
                ST_Y(ST_Transform({input_geom}, '{crs_str}', 'EPSG:3857', always_xy := true)) AS y
            FROM {input_view}
        """)
        n_features = self.con.execute(
            "SELECT COUNT(*) FROM features_metric"
        ).fetchone()[0]
        n_weighted_features = self.con.execute(
            "SELECT SUM(weight) FROM features_metric"
        ).fetchone()[0]
        if n_features == 0:
            raise ValueError("No features found in input data")
        if n_features < k:
            raise ValueError(f"Cannot create {k} clusters from {n_features} features")

        if params.cluster_type == ClusterType.equal_size:
            # Step 1: Create initial population using K-means for seeding
            self._run_kmeans(k, max_iter=50)
            self._build_distance_neighbor_graph(n_features, k)

            # Create ga_assignments table to store all individuals and ga_seeds table to store seed array
            self.con.execute(
                """ CREATE OR REPLACE TEMP TABLE ga_assignments (individual_id INTEGER,feature_id INTEGER, cluster_id INTEGER ) """
            )
            self.con.execute(
                """ CREATE OR REPLACE TEMP TABLE ga_seeds ( individual_id INTEGER, cluster_id INTEGER,seed_id INTEGER) """
            )

            self._init_population(k)
            if n_features > 1000:
                batch_size = 5
                for batch_start in range(0, self.population_size, batch_size):
                    batch_ids = list(
                        range(
                            batch_start,
                            min(batch_start + batch_size, self.population_size),
                        )
                    )
                    self._create_individuals_from_seeds_batch(
                        batch_ids, k, n_features, n_weighted_features, use_compactness
                    )
            else:
                self._create_individuals_from_seeds_batch(
                    list(range(self.population_size)),
                    k,
                    n_features,
                    n_weighted_features,
                    use_compactness,
                )

            logger.info(
                "Created initial population of %d individuals", self.population_size
            )

            # Genetic algorithm evolution
            best_fitness = float("inf")
            best_individual = 0
            stagnation_count = 0
            population_ids = list(range(self.population_size))
            next_individual_id = self.population_size

            for gen in range(self.n_generations + 1):
                # Calculate fitness for current population and track best solution
                fitness_dict = self._calculate_fitness_batch(
                    population_ids,
                    k,
                    n_weighted_features,
                    use_compactness,
                    max_distance,
                )
                fitness_scores = [
                    fitness_dict.get(i, {}).get("total", float("inf"))
                    for i in population_ids
                ]
                gen_best_fitness = (
                    min(fitness_scores) if fitness_scores else float("inf")
                )
                improvement_threshold = 1e-6

                if gen_best_fitness < best_fitness - improvement_threshold:
                    best_fitness = gen_best_fitness
                    best_individual = population_ids[fitness_scores.index(best_fitness)]
                    stagnation_count = 0

                    # Log detailed fitness breakdown from the same calculation
                    best_detail = fitness_dict[best_individual]
                    logger.info(
                        "Generation %d: NEW BEST fitness = %.6f (size=%.6f, compactness=%.6f)",
                        gen,
                        best_fitness,
                        best_detail["size"],
                        best_detail["compactness"],
                    )
                else:
                    stagnation_count += 1
                    if gen % 5 == 0:
                        logger.info(
                            "Generation %d: fitness = %.6f, stagnation = %d",
                            gen,
                            gen_best_fitness,
                            stagnation_count,
                        )

                # Stop if this is the last generation or early stopping
                if gen >= self.n_generations or stagnation_count >= 10:
                    if stagnation_count >= 10:
                        logger.info(
                            "Early stopping at generation %d due to stagnation",
                            gen,
                        )
                    break

                # Apply genetic operations to create next generation
                if gen < self.n_generations and stagnation_count < 10:
                    # Sort population by fitness to select parents and keep elite individuals
                    sorted_indices = np.argsort(fitness_scores)
                    n_parents = self.population_size // 2
                    parent_ids = [population_ids[i] for i in sorted_indices[:n_parents]]
                    n_elite = max(2, self.population_size // 10)
                    elite_ids = [population_ids[i] for i in sorted_indices[:n_elite]]

                    # Create next generation
                    new_individual_ids, elite_ids_kept, next_individual_id = (
                        self._evolve_generation_batch(
                            parent_ids,
                            elite_ids,
                            next_individual_id,
                            k,
                            n_features,
                            n_weighted_features,
                            use_compactness,
                            has_field_weights,
                        )
                    )

                    # Update population for next iteration
                    population_ids = list(elite_ids_kept) + list(new_individual_ids)
                    if len(population_ids) > self.population_size:
                        population_ids = population_ids[: self.population_size]

                    if population_ids:
                        current_ids = ",".join(map(str, population_ids))
                        # Rebuild tables instead of DELETE to avoid DuckDB tombstone fragmentation
                        # DELETE marks rows as deleted but doesn't reclaim space, causing progressive slowdown
                        self.con.execute(f"""
                            CREATE OR REPLACE TEMP TABLE ga_assignments AS
                            SELECT individual_id, feature_id, cluster_id
                            FROM ga_assignments
                            WHERE individual_id IN ({current_ids})
                        """)
                        self.con.execute(f"""
                            CREATE OR REPLACE TEMP TABLE ga_seeds AS
                            SELECT individual_id, cluster_id, seed_id
                            FROM ga_seeds
                            WHERE individual_id IN ({current_ids})
                        """)
        else:
            self._run_kmeans(k, max_iter=100)
            best_individual = "kmeans"

        # Unify assignments into a single view for stats and output
        if best_individual == "kmeans":
            self.con.execute("""
                CREATE OR REPLACE TEMP VIEW final_assignments AS
                SELECT feature_id, cluster_id FROM kmeans_assignments
            """)
        else:
            self.con.execute(f"""
                CREATE OR REPLACE TEMP VIEW final_assignments AS
                SELECT feature_id, cluster_id
                FROM ga_assignments
                WHERE individual_id = {best_individual}
            """)

        # Prepare output paths
        output_path = Path(params.output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path = Path(params.output_summary_path)
        summary_path.parent.mkdir(parents=True, exist_ok=True)

        # Output 1: Original features with cluster_id
        self.con.execute("""
            CREATE OR REPLACE TEMP VIEW clustering_result AS
            SELECT
                p.* EXCLUDE (feature_id, lon, lat, x, y, weight),
                a.cluster_id
            FROM features_metric p
            JOIN final_assignments a ON p.feature_id = a.feature_id
        """)

        write_optimized_parquet(
            self.con,
            "clustering_result",
            output_path,
            geometry_column=input_geom,
        )

        # Output 2: Multifeature summary per cluster with characteristics
        self.con.execute(f"""
            CREATE OR REPLACE TEMP VIEW cluster_summary AS
            WITH cluster_points AS (
                SELECT a.cluster_id, p.feature_id, p.x, p.y
                FROM final_assignments a
                JOIN features_metric p ON a.feature_id = p.feature_id
            ),
            pairwise_distances AS (
                SELECT
                    cp1.cluster_id,
                    MAX(SQRT(
                        (cp1.x - cp2.x) * (cp1.x - cp2.x) +
                        (cp1.y - cp2.y) * (cp1.y - cp2.y)
                    )) AS max_distance
                FROM cluster_points cp1
                JOIN cluster_points cp2 ON cp1.cluster_id = cp2.cluster_id
                                        AND cp1.feature_id < cp2.feature_id
                GROUP BY cp1.cluster_id
            )
            SELECT
                a.cluster_id,
                ST_Collect(LIST(p.{input_geom})) AS geometry,
                SUM(p.weight) AS cluster_size,
                COALESCE(pd.max_distance, 0) AS max_distance
            FROM final_assignments a
            JOIN features_metric p ON a.feature_id = p.feature_id
            LEFT JOIN pairwise_distances pd ON a.cluster_id = pd.cluster_id
            GROUP BY a.cluster_id, pd.max_distance
        """)

        write_optimized_parquet(
            self.con,
            "cluster_summary",
            summary_path,
            geometry_column="geometry",
        )

        features_meta = DatasetMetadata(
            path=str(output_path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Point",
            geometry_column=input_geom,
            crs=crs_str,
        )
        summary_meta = DatasetMetadata(
            path=str(summary_path),
            source_type="vector",
            format="geoparquet",
            geometry_type="MultiPoint",
            geometry_column="geometry",
            crs=crs_str,
        )
        return [(output_path, features_meta), (summary_path, summary_meta)]

    def _build_distance_neighbor_graph(self: Self, n_features: int, k: int) -> None:
        """
        Build neighbor graph: find nearest candidates per feature, then select
        a subset that balances proximity with directional diversity (angular spread).
        """
        n_candidates = 6
        n_sectors = 3
        n_neighbors = 3

        # Step 1: Find nearest candidates with angle to each
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE neighbor_candidates AS
            WITH ranked AS (
                SELECT
                    p1.feature_id AS from_id,
                    p2.feature_id AS to_id,
                    (p1.x - p2.x)*(p1.x - p2.x) + (p1.y - p2.y)*(p1.y - p2.y) AS dist_sq,
                    ATAN2(p2.y - p1.y, p2.x - p1.x) AS angle,
                    ROW_NUMBER() OVER (
                        PARTITION BY p1.feature_id
                        ORDER BY (p1.x - p2.x)*(p1.x - p2.x) + (p1.y - p2.y)*(p1.y - p2.y)
                    ) AS dist_rank
                FROM features_metric p1, features_metric p2
                WHERE p1.feature_id != p2.feature_id
            )
            SELECT from_id, to_id, dist_sq, dist_rank, angle,
                   FLOOR((angle + PI()) / (2 * PI() / {n_sectors}))::INTEGER % {n_sectors} AS sector
            FROM ranked
            WHERE dist_rank <= {n_candidates}
        """)

        # Step 2: Pick best per sector (closest in each angular sector), then fill remaining slots by pure proximity
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE neighbors AS
            WITH sector_best AS (
                SELECT from_id, to_id, dist_sq, sector,
                    ROW_NUMBER() OVER (
                        PARTITION BY from_id, sector ORDER BY dist_sq
                    ) AS sector_rank
                FROM neighbor_candidates
            ),
            sector_picks AS (
                SELECT from_id, to_id, dist_sq
                FROM sector_best
                WHERE sector_rank = 1
            ),
            sector_pick_count AS (
                SELECT from_id, COUNT(*) AS n_picked
                FROM sector_picks
                GROUP BY from_id
            ),
            remaining_slots AS (
                SELECT nc.from_id, nc.to_id, nc.dist_sq,
                    ROW_NUMBER() OVER (
                        PARTITION BY nc.from_id ORDER BY nc.dist_sq
                    ) AS fill_rank
                FROM neighbor_candidates nc
                LEFT JOIN sector_picks sp ON nc.from_id = sp.from_id AND nc.to_id = sp.to_id
                WHERE sp.to_id IS NULL
            ),
            fill_picks AS (
                SELECT rs.from_id, rs.to_id, rs.dist_sq
                FROM remaining_slots rs
                JOIN sector_pick_count spc ON rs.from_id = spc.from_id
                WHERE rs.fill_rank <= ({n_neighbors} - spc.n_picked)
            ),
            all_picks AS (
                SELECT from_id, to_id FROM sector_picks
                UNION ALL
                SELECT from_id, to_id FROM fill_picks
            )
            SELECT from_id, to_id FROM all_picks
        """)

        # Add reverse edges to make graph bidirectional
        self.con.execute("""
            INSERT INTO neighbors (from_id, to_id)
            SELECT DISTINCT n.to_id, n.from_id
            FROM neighbors n
            WHERE NOT EXISTS (
                SELECT 1 FROM neighbors ex
                WHERE ex.from_id = n.to_id AND ex.to_id = n.from_id
            )
        """)

        logger.info(
            "Neighbor graph built: %d edges",
            self.con.execute("SELECT COUNT(*) FROM neighbors").fetchone()[0],
        )

        # Free intermediate table and index neighbors for fast lookup during zone growing
        self.con.execute("DROP TABLE IF EXISTS neighbor_candidates")
        self.con.execute(
            "CREATE INDEX IF NOT EXISTS idx_neighbors_from ON neighbors(from_id)"
        )

    def _run_kmeans(self: Self, k: int, max_iter: int = 100) -> None:
        """
        Run K-means clustering on features.
        """
        # Initialize centroids
        self.con.execute("""
        CREATE OR REPLACE TEMP TABLE centroids AS
        SELECT 0 AS cluster_id, x AS cx, y AS cy
        FROM features_metric
        ORDER BY RANDOM()
        LIMIT 1;""")

        for i in range(1, k):
            self.con.execute(f"""
                INSERT INTO centroids(cluster_id, cx, cy)
                SELECT {i}, x, y
                FROM features_metric p
                WHERE p.feature_id NOT IN (
                    SELECT p2.feature_id
                    FROM features_metric p2
                    JOIN centroids c ON (p2.x = c.cx AND p2.y = c.cy)
                )
                ORDER BY (
                    SELECT MIN((p.x - c.cx)*(p.x - c.cx) + (p.y - c.cy)*(p.y - c.cy))
                    FROM centroids c
                ) DESC
                LIMIT 1
            """)

        for _ in range(max_iter):
            # Assignment step: assign each feature to nearest centroid
            self.con.execute("""
                CREATE OR REPLACE TEMP TABLE kmeans_assignments AS
                WITH distances AS (
                    SELECT
                        p.feature_id, c.cluster_id,
                        (p.x - c.cx) * (p.x - c.cx) + (p.y - c.cy) * (p.y - c.cy) AS dist_sq
                    FROM features_metric p CROSS JOIN centroids c
                ),
                ranked AS (
                    SELECT feature_id, cluster_id,
                        ROW_NUMBER() OVER (PARTITION BY feature_id ORDER BY dist_sq) AS rn
                    FROM distances
                )
                SELECT feature_id, cluster_id FROM ranked WHERE rn = 1
            """)

            # Update centroids
            self.con.execute(f"""
                CREATE OR REPLACE TEMP TABLE new_centroids AS
                WITH updated_centroids AS (
                    SELECT
                        a.cluster_id,
                        AVG(p.x) AS cx,
                        AVG(p.y) AS cy
                    FROM kmeans_assignments a
                    JOIN features_metric p ON a.feature_id = p.feature_id
                    GROUP BY a.cluster_id
                ),
                all_cluster_ids AS (
                    SELECT cluster_id FROM generate_series(0, {k-1}) AS g(cluster_id)
                )
                SELECT
                    aci.cluster_id,
                    COALESCE(uc.cx, (SELECT AVG(x) FROM features_metric)) AS cx,
                    COALESCE(uc.cy, (SELECT AVG(y) FROM features_metric)) AS cy
                FROM all_cluster_ids aci
                LEFT JOIN updated_centroids uc ON aci.cluster_id = uc.cluster_id
            """)

            # Check convergence
            max_movement = self.con.execute("""
                SELECT COALESCE(MAX(
                    (c.cx - n.cx) * (c.cx - n.cx) + (c.cy - n.cy) * (c.cy - n.cy)
                ), 0)
                FROM centroids c JOIN new_centroids n ON c.cluster_id = n.cluster_id
            """).fetchone()[0]

            self.con.execute("DROP TABLE IF EXISTS centroids")
            self.con.execute("ALTER TABLE new_centroids RENAME TO centroids")

            if max_movement < 1e-8:
                break

    def _init_population(self, k) -> None:
        """
        Create initial population for GA:
        - 25% pure K-means seeded individuals
        - 50% mutated K-means (seeds randomly replaced with probability mutation_rate)
        - 25% random aliens (random features as seeds)
        """
        n_kmeans_based = self.population_size // 4
        n_mutations = self.population_size // 2
        n_aliens = self.population_size - n_kmeans_based - n_mutations

        # Extract K-means seeds: find feature closest to each K-means centroid
        self.con.execute("""
            CREATE OR REPLACE TEMP TABLE kmeans_seeds AS
            WITH centroid_distances AS (
                SELECT
                    c.cluster_id AS cluster_id,
                    p.feature_id,
                    (p.x - c.cx) * (p.x - c.cx) + (p.y - c.cy) * (p.y - c.cy) AS dist_sq
                FROM centroids c
                CROSS JOIN features_metric p
            ),
            closest_features AS (
                SELECT
                    cluster_id, feature_id,
                    ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY dist_sq) AS rn
                FROM centroid_distances
            )
            SELECT cluster_id, feature_id AS seed_id FROM closest_features WHERE rn = 1
        """)

        # Create all initial individuals
        self.con.execute(f"""
            INSERT INTO ga_seeds (individual_id, cluster_id, seed_id)
            WITH kmeans_individuals AS (
                SELECT
                    individual_idx - 1 AS individual_id,
                    ks.cluster_id,
                    ks.seed_id
                FROM generate_series(1, {n_kmeans_based}) AS g(individual_idx)
                CROSS JOIN kmeans_seeds ks
            ),
            mutation_individuals AS (
                SELECT
                    {n_kmeans_based} + individual_idx - 1 AS individual_id,
                    ks.cluster_id,
                    CASE
                        WHEN random() < {self.mutation_rate}
                        THEN (SELECT feature_id FROM features_metric ORDER BY HASH(individual_idx * 1000 + ks.cluster_id + random()) LIMIT 1)
                        ELSE ks.seed_id
                    END AS seed_id
                FROM generate_series(1, {n_mutations}) AS g(individual_idx)
                CROSS JOIN kmeans_seeds ks
            ),
            random_seeds AS (
                SELECT
                    alien_idx,
                    feature_id AS seed_id,
                    ROW_NUMBER() OVER (PARTITION BY alien_idx ORDER BY random()) AS seed_rank
                FROM generate_series(1, {n_aliens}) AS a(alien_idx)
                CROSS JOIN features_metric
            ),
            alien_individuals AS (
                SELECT
                    {n_kmeans_based + n_mutations} + alien_idx - 1 AS individual_id,
                    (seed_rank - 1) AS cluster_id,
                    seed_id
                FROM random_seeds
                WHERE seed_rank <= {k}
            )
            SELECT * FROM kmeans_individuals
            UNION ALL
            SELECT individual_id, cluster_id, COALESCE(seed_id, (SELECT feature_id FROM features_metric LIMIT 1))
            FROM mutation_individuals
            UNION ALL
            SELECT * FROM alien_individuals
        """)

        # Deduplicate seeds: if 2+ clusters share the same seed_id within an individual, keep the lowest cluster_id and re-assign others to random unused features.
        self.con.execute("""
            WITH duplicates AS (
                SELECT individual_id, cluster_id, seed_id,
                       ROW_NUMBER() OVER (PARTITION BY individual_id, seed_id ORDER BY cluster_id) AS dup_rank
                FROM ga_seeds
            ),
            needs_fix AS (
                SELECT individual_id, cluster_id,
                       ROW_NUMBER() OVER (PARTITION BY individual_id ORDER BY cluster_id) AS fix_rank
                FROM duplicates WHERE dup_rank > 1
            ),
            used_seeds AS (
                SELECT individual_id, seed_id FROM ga_seeds
            ),
            available AS (
                SELECT gs.individual_id, p.feature_id,
                       ROW_NUMBER() OVER (PARTITION BY gs.individual_id ORDER BY random()) AS avail_rank
                FROM (SELECT DISTINCT individual_id FROM needs_fix) gs
                CROSS JOIN features_metric p
                WHERE NOT EXISTS (
                    SELECT 1 FROM used_seeds us
                    WHERE us.individual_id = gs.individual_id AND us.seed_id = p.feature_id
                )
            )
            UPDATE ga_seeds
            SET seed_id = av.feature_id
            FROM needs_fix nf
            JOIN available av ON nf.individual_id = av.individual_id AND nf.fix_rank = av.avail_rank
            WHERE ga_seeds.individual_id = nf.individual_id
              AND ga_seeds.cluster_id = nf.cluster_id
        """)

    def _calculate_fitness_batch(
        self: Self,
        individual_ids: list[int],
        k: int,
        n_weighted_features: int,
        use_compactness: bool,
        max_distance: float,
    ) -> dict[int, dict]:
        """
        Calculate fitness scores.
        Returns dict of {individual_id: {'total': float, 'size': float, 'compactness': float}}
        """
        if not individual_ids:
            return {}

        target_size = n_weighted_features / k
        ids_str = ",".join(map(str, individual_ids))

        # Build SQL dynamically to avoid code duplication
        base_sql = f"""
            WITH individual_data AS (
                SELECT a.individual_id, a.feature_id, a.cluster_id, p.x, p.y, p.weight
                FROM ga_assignments a
                JOIN features_metric p ON a.feature_id = p.feature_id
                WHERE a.individual_id IN ({ids_str})
            ),
            zone_stats AS (
                SELECT
                    individual_id, cluster_id,
                    SUM(weight) AS zone_size,
                    AVG(x) AS cx, AVG(y) AS cy
                FROM individual_data
                GROUP BY individual_id, cluster_id
            ),
            size_fitness AS (
                SELECT individual_id,
                    AVG(POWER((zone_size - {target_size}) / {target_size}, 2))
                      AS size_score
                FROM zone_stats
                GROUP BY individual_id
            )"""

        if use_compactness:
            compactness_sql = f""",
            feature_centroid_dist AS (
                SELECT
                    id.individual_id, id.cluster_id,
                    (id.x - zs.cx) * (id.x - zs.cx) + (id.y - zs.cy) * (id.y - zs.cy) AS dist_sq
                FROM individual_data id
                JOIN zone_stats zs ON id.individual_id = zs.individual_id AND id.cluster_id = zs.cluster_id
            ),
            compactness_per_zone AS (
                SELECT individual_id, cluster_id,
                    case when SQRT(dist_sq) - {max_distance}/2>0 then MAX(POWER((SQRT(dist_sq) - {max_distance}/2) / ({max_distance}/2), 2)) ELSE NULL END AS max_zone_length
                FROM feature_centroid_dist
                GROUP BY individual_id, cluster_id,dist_sq
            ),
            compactness_fitness AS (
                SELECT individual_id,  avg(max_zone_length) AS compactness_score
                FROM compactness_per_zone
                GROUP BY individual_id
            )
            SELECT sf.individual_id, sf.size_score, cf.compactness_score
            FROM size_fitness sf
            JOIN compactness_fitness cf ON sf.individual_id = cf.individual_id"""
        else:
            compactness_sql = """
            SELECT individual_id, size_score, 0 AS compactness_score
            FROM size_fitness"""

        results = self.con.execute(base_sql + compactness_sql).df()

        fitness_dict = {}
        for _, row in results.iterrows():
            ind_id = int(row["individual_id"])
            size_f = row["size_score"] if row["size_score"] is not None else 0.0
            compact_f = (
                row["compactness_score"]
                if row["compactness_score"] is not None
                else 0.0
            )
            size_weighted = self.equal_size_weight * size_f
            compact_weighted = self.compactness_weight * compact_f
            fitness_dict[ind_id] = {
                "total": size_weighted + compact_weighted,
                "size": size_weighted,
                "compactness": compact_weighted,
            }
        return fitness_dict

    def _evolve_generation_batch(
        self: Self,
        parent_ids: list[int],
        elite_ids: list[int],
        next_individual_id: int,
        k: int,
        n_features: int,
        n_weighted_features: float,
        use_compactness: bool,
        has_field_weights: bool,
    ) -> tuple[list[int], list[int], int]:
        """
        Create new generation: crossover, mutation, and zone growing.
        Returns: (new_individual_ids, elite_ids_kept, updated_next_individual_id)
        """
        n_elite = len(elite_ids)
        n_offspring_needed = self.population_size - n_elite
        n_aliens = max(1, int(self.population_size * self.mutation_rate))
        n_crossover_offspring = n_offspring_needed - n_aliens

        parent_ids_str = ",".join(map(str, parent_ids))
        n_parents = len(parent_ids)

        # Generate offspring seeds (crossover + mutation)
        shuffle_seed = np.random.randint(0, 1000000)
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE parent_list AS
            SELECT individual_id, ROW_NUMBER() OVER (ORDER BY HASH(individual_id + {shuffle_seed})) AS parent_rank
            FROM (SELECT DISTINCT individual_id FROM ga_seeds WHERE individual_id IN ({parent_ids_str}))
        """)
        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE generation_offspring_seeds AS
            WITH parent_seeds AS (
                SELECT individual_id, cluster_id, seed_id
                FROM ga_seeds
                WHERE individual_id IN ({parent_ids_str})
            ),
            crossover_offspring AS (
                SELECT
                    {next_individual_id} + offspring_idx - 1 AS individual_id,
                    ps1.cluster_id,
                    CASE
                        WHEN random() < 0.5
                        THEN ps1.seed_id
                        ELSE ps2.seed_id
                    END AS base_seed_id
                FROM generate_series(1, {n_crossover_offspring}) AS o(offspring_idx)
                CROSS JOIN parent_seeds ps1
                JOIN parent_seeds ps2 ON ps1.cluster_id = ps2.cluster_id
                WHERE ps1.individual_id = (
                    SELECT individual_id FROM parent_list
                    WHERE parent_rank = ((o.offspring_idx * 2 - 1) % {n_parents}) + 1
                )
                AND ps2.individual_id = (
                    SELECT individual_id FROM parent_list
                    WHERE parent_rank = ((o.offspring_idx * 2) % {n_parents}) + 1
                )
            ),
            mutated_offspring AS (
                SELECT
                    individual_id,
                    cluster_id,
                    CASE
                        WHEN random() < {self.mutation_rate}
                        THEN (SELECT feature_id FROM features_metric ORDER BY random() LIMIT 1)
                        ELSE base_seed_id
                    END AS seed_id
                FROM crossover_offspring
            ),
            aliens AS (
                SELECT
                    {next_individual_id + n_crossover_offspring} + (alien_idx - 1) AS individual_id,
                    (seed_rank - 1) AS cluster_id,
                    seed_id
                FROM (
                    SELECT
                        alien_idx,
                        feature_id AS seed_id,
                        ROW_NUMBER() OVER (PARTITION BY alien_idx ORDER BY random()) AS seed_rank
                    FROM generate_series(1, {n_aliens}) AS a(alien_idx)
                    CROSS JOIN features_metric
                )
                WHERE seed_rank <= {k}
            )
            SELECT individual_id, cluster_id, seed_id FROM mutated_offspring
            UNION ALL
            SELECT individual_id, cluster_id, seed_id FROM aliens
        """)

        # Insert new seeds into ga_seeds
        self.con.execute("""
            INSERT INTO ga_seeds (individual_id, cluster_id, seed_id)
            SELECT individual_id, cluster_id, seed_id FROM generation_offspring_seeds
        """)

        # Deduplicate seeds: if crossover/mutation assigned the same feature to 2+ clusters, keep one and re-assign the others to random unused features.
        self.con.execute("""
            WITH duplicates AS (
                SELECT individual_id, cluster_id, seed_id,
                       ROW_NUMBER() OVER (PARTITION BY individual_id, seed_id ORDER BY cluster_id) AS dup_rank
                FROM ga_seeds
            ),
            needs_fix AS (
                SELECT individual_id, cluster_id,
                       ROW_NUMBER() OVER (PARTITION BY individual_id ORDER BY cluster_id) AS fix_rank
                FROM duplicates WHERE dup_rank > 1
            ),
            used_seeds AS (
                SELECT individual_id, seed_id FROM ga_seeds
            ),
            available AS (
                SELECT gs.individual_id, p.feature_id,
                       ROW_NUMBER() OVER (PARTITION BY gs.individual_id ORDER BY random()) AS avail_rank
                FROM (SELECT DISTINCT individual_id FROM needs_fix) gs
                CROSS JOIN features_metric p
                WHERE NOT EXISTS (
                    SELECT 1 FROM used_seeds us
                    WHERE us.individual_id = gs.individual_id AND us.seed_id = p.feature_id
                )
            )
            UPDATE ga_seeds
            SET seed_id = av.feature_id
            FROM needs_fix nf
            JOIN available av ON nf.individual_id = av.individual_id AND nf.fix_rank = av.avail_rank
            WHERE ga_seeds.individual_id = nf.individual_id
              AND ga_seeds.cluster_id = nf.cluster_id
        """)

        new_individual_ids = (
            self.con.execute("""  SELECT DISTINCT individual_id FROM generation_offspring_seeds ORDER BY individual_id
        """)
            .df()["individual_id"]
            .tolist()
        )

        if not new_individual_ids:
            return elite_ids, elite_ids, next_individual_id

        logger.info("Creating new individuals via zone growing")
        if n_features > 1000:
            batch_size = max(5, len(new_individual_ids) // 4)
            for batch_start in range(0, len(new_individual_ids), batch_size):
                batch_ids = new_individual_ids[batch_start : batch_start + batch_size]
                self._create_individuals_from_seeds_batch(
                    batch_ids, k, n_features, n_weighted_features, use_compactness
                )
        else:
            self._create_individuals_from_seeds_batch(
                new_individual_ids, k, n_features, n_weighted_features, use_compactness
            )

        updated_next_id = next_individual_id + len(new_individual_ids)
        return new_individual_ids, elite_ids, updated_next_id

    def _create_individuals_from_seeds_batch(
        self: Self,
        individual_ids: list[int],
        k: int,
        n_features: int,
        n_weighted_features: float,
        use_compactness: bool,
    ) -> None:
        """
        Create multiple individuals from their seeds using a growing process to maintain contiguity. Favoring proximity if use_compactness is True.
        Multiple tables are created:
        1. batch_zone_grow: Main working table containing all features for all individuals in the batch.
           - cluster_id = -1 for unassigned features, >= 0 for assigned features
           - Includes coordinates (x,y) and weight to avoid repeated joins during hot loop

        2. batch_assignments: Temporary staging table for new assignments in each iteration.
           - Holds candidate feature assignments before applying them to batch_zone_grow
           - Cleared/truncated at start of each iteration

        3. zone_sizes: Tracks current total weight (size) of each zone for each individual.
           - Updated incrementally using direct merge operations for efficiency

        4. zone_centroids_grow: Zone centroids for compactness-aware growing (optional).
           - Only created when use_compactness=True
           - Computed fresh each iteration for distance-based candidate ranking
        """
        if not individual_ids:
            return
        ids_str = ",".join(map(str, individual_ids))

        self.con.execute(f"""
            CREATE OR REPLACE TEMP TABLE batch_zone_grow AS
            WITH seed_assignments AS (
                SELECT individual_id, seed_id AS feature_id, cluster_id
                FROM ga_seeds
                WHERE individual_id IN ({ids_str})
            )
            SELECT
                i.individual_id,
                p.feature_id,
                p.weight,
                p.x,
                p.y,
                COALESCE(s.cluster_id, -1) AS cluster_id
            FROM (SELECT UNNEST([{ids_str}]) AS individual_id) i
            CROSS JOIN features_metric p
            LEFT JOIN seed_assignments s ON i.individual_id = s.individual_id
                                AND p.feature_id = s.feature_id
        """)

        self.con.execute("""
            CREATE OR REPLACE TEMP TABLE batch_assignments (
                individual_id INTEGER,
                feature_id INTEGER,
                cluster_id INTEGER
            )
        """)

        self.con.execute("""
            CREATE OR REPLACE TEMP TABLE zone_sizes AS
            SELECT individual_id, cluster_id, SUM(weight) AS size
            FROM batch_zone_grow
            WHERE cluster_id >= 0
            GROUP BY individual_id, cluster_id
        """)

        # Pre-create reusable temp tables to avoid repeated CREATE/DROP in the hot loop
        if use_compactness:
            self.con.execute("""
                CREATE OR REPLACE TEMP TABLE zone_centroids_grow (
                    individual_id INTEGER, cluster_id INTEGER, cx DOUBLE, cy DOUBLE
                )
            """)
        self.con.execute("""
            CREATE OR REPLACE TEMP TABLE _new_zone_weights (
                individual_id INTEGER, cluster_id INTEGER, add_weight DOUBLE
            )
        """)

        target_size = n_weighted_features // k
        features_per_zone_per_iter = max(5, min(15, target_size // 10))
        max_iterations = max(75, (n_features // (k * features_per_zone_per_iter)) + 50)
        if target_size <= 50:
            features_per_zone_per_iter = 1
            max_iterations = 50
        # Slow growth rate when zones approach target size to avoid overshooting
        slow_growth_rate = max(1, features_per_zone_per_iter // 2)
        slow_threshold = target_size * 0.95
        for iteration in range(max_iterations):
            if use_compactness:
                self.con.execute("TRUNCATE zone_centroids_grow")
                self.con.execute("""
                    INSERT INTO zone_centroids_grow
                    SELECT individual_id, cluster_id, AVG(x) AS cx, AVG(y) AS cy
                    FROM batch_zone_grow
                    WHERE cluster_id >= 0
                    GROUP BY individual_id, cluster_id
                """)

            self.con.execute("TRUNCATE batch_assignments")

            # Build ORDER BY clause based on compactness setting
            if use_compactness:
                zone_order_clause = "dist_to_centroid, zone_size, rand"
                conflict_order_clause = "zone_size, dist_to_centroid, rand"
                distance_select = ", SQRT((fc.pt_x - zc.cx)*(fc.pt_x - zc.cx) + (fc.pt_y - zc.cy)*(fc.pt_y - zc.cy)) AS dist_to_centroid"
                distance_join = "JOIN zone_centroids_grow zc ON fc.individual_id = zc.individual_id AND fc.cluster_id = zc.cluster_id"
            else:
                zone_order_clause = "zone_size, rand"
                conflict_order_clause = "zone_size, rand"
                distance_select = ""
                distance_join = ""

            self.con.execute(f"""
                INSERT INTO batch_assignments
                WITH frontier_candidates AS (
                    SELECT DISTINCT
                        f.individual_id, f.cluster_id, n.to_id AS candidate_pt,
                        zs.size AS zone_size,
                        random() AS rand,
                        g.x AS pt_x, g.y AS pt_y
                    FROM batch_zone_grow f
                    JOIN neighbors n ON f.feature_id = n.from_id
                    JOIN batch_zone_grow g ON f.individual_id = g.individual_id
                                            AND n.to_id = g.feature_id
                    JOIN zone_sizes zs ON f.individual_id = zs.individual_id
                                       AND f.cluster_id = zs.cluster_id
                    WHERE f.cluster_id >= 0 AND g.cluster_id = -1
                ),
                ranked AS (
                    SELECT
                        fc.individual_id, fc.cluster_id, fc.candidate_pt, fc.zone_size, fc.rand{distance_select},
                        ROW_NUMBER() OVER (
                            PARTITION BY fc.individual_id, fc.cluster_id
                            ORDER BY {zone_order_clause}
                        ) AS zone_rank,
                        ROW_NUMBER() OVER (
                            PARTITION BY fc.individual_id, fc.candidate_pt
                            ORDER BY {conflict_order_clause}
                        ) AS conflict_rank
                    FROM frontier_candidates fc
                    {distance_join}
                )
                SELECT individual_id, candidate_pt AS feature_id, cluster_id
                FROM ranked
                WHERE zone_rank <= CASE WHEN zone_size >= {slow_threshold} THEN {slow_growth_rate} ELSE {features_per_zone_per_iter} END
                  AND conflict_rank = 1
            """)

            assigned = self.con.execute(
                "SELECT COUNT(*) FROM batch_assignments"
            ).fetchone()[0]
            if assigned == 0:
                break
            # Update zone assignments
            self.con.execute("""
                UPDATE batch_zone_grow bzg
                SET cluster_id = ba.cluster_id
                FROM batch_assignments ba
                WHERE bzg.individual_id = ba.individual_id
                  AND bzg.feature_id = ba.feature_id
            """)

            # Materialize new weights once, then reuse for both UPDATE and INSERT
            self.con.execute("TRUNCATE _new_zone_weights")
            self.con.execute("""
                INSERT INTO _new_zone_weights
                SELECT ba.individual_id, ba.cluster_id, SUM(bzg.weight)
                FROM batch_assignments ba
                JOIN batch_zone_grow bzg ON bzg.individual_id = ba.individual_id
                                          AND bzg.feature_id = ba.feature_id
                GROUP BY ba.individual_id, ba.cluster_id
            """)
            self.con.execute("""
                UPDATE zone_sizes
                SET size = zone_sizes.size + nw.add_weight
                FROM _new_zone_weights nw
                WHERE zone_sizes.individual_id = nw.individual_id
                  AND zone_sizes.cluster_id = nw.cluster_id
            """)
            self.con.execute("""
                INSERT INTO zone_sizes (individual_id, cluster_id, size)
                SELECT nw.individual_id, nw.cluster_id, nw.add_weight
                FROM _new_zone_weights nw
                WHERE NOT EXISTS (
                    SELECT 1 FROM zone_sizes zs
                    WHERE zs.individual_id = nw.individual_id
                      AND zs.cluster_id = nw.cluster_id
                )
            """)

            # Early exit check
            unassigned_count = self.con.execute(
                "SELECT COUNT(*) FROM batch_zone_grow WHERE cluster_id = -1"
            ).fetchone()[0]
            if unassigned_count == 0:
                break
        unassigned_count = self.con.execute(
            "SELECT COUNT(*) FROM batch_zone_grow WHERE cluster_id = -1"
        ).fetchone()[0]
        if unassigned_count > 0:
            self.con.execute("""
                WITH unassigned AS (
                    SELECT individual_id, feature_id, x, y
                    FROM batch_zone_grow
                    WHERE cluster_id = -1
                ),
                zone_centroids AS (
                    SELECT individual_id, cluster_id, AVG(x) AS cx, AVG(y) AS cy
                    FROM batch_zone_grow
                    WHERE cluster_id >= 0
                    GROUP BY individual_id, cluster_id
                ),
                nearest AS (
                    SELECT
                        u.individual_id,
                        u.feature_id,
                        zc.cluster_id,
                        ROW_NUMBER() OVER (
                            PARTITION BY u.individual_id, u.feature_id
                            ORDER BY (u.x - zc.cx)*(u.x - zc.cx) + (u.y - zc.cy)*(u.y - zc.cy)
                        ) AS rn
                    FROM unassigned u
                    JOIN zone_centroids zc ON u.individual_id = zc.individual_id
                )
                UPDATE batch_zone_grow bzg
                SET cluster_id = nr.cluster_id
                FROM nearest nr
                WHERE bzg.individual_id = nr.individual_id
                  AND bzg.feature_id = nr.feature_id
                  AND nr.rn = 1
            """)
        # Refresh zone sizes after unassigned feature assignment
        self.con.execute("""
            CREATE OR REPLACE TEMP TABLE zone_sizes AS
            SELECT individual_id, cluster_id, SUM(weight) AS size
            FROM batch_zone_grow
            WHERE cluster_id >= 0
            GROUP BY individual_id, cluster_id
        """)
        # Boundary correction: swap boundary features to smaller neighboring zones.
        self.con.execute("""
            WITH boundary_pairs AS (
                SELECT DISTINCT
                    bzg.individual_id,
                    bzg.feature_id,
                    bzg.cluster_id AS current_cluster,
                    nbr.cluster_id AS neighbor_cluster
                FROM batch_zone_grow bzg
                JOIN neighbors n ON bzg.feature_id = n.from_id
                JOIN batch_zone_grow nbr ON bzg.individual_id = nbr.individual_id
                                          AND n.to_id = nbr.feature_id
                WHERE bzg.cluster_id >= 0
                  AND nbr.cluster_id >= 0
                  AND nbr.cluster_id != bzg.cluster_id
            ),
            swap_candidates AS (
                SELECT
                    bp.individual_id,
                    bp.feature_id,
                    bp.neighbor_cluster AS target_cluster,
                    ROW_NUMBER() OVER (
                        PARTITION BY bp.individual_id, bp.feature_id
                        ORDER BY zs_target.size
                    ) AS rn
                FROM boundary_pairs bp
                JOIN zone_sizes zs_curr ON bp.individual_id = zs_curr.individual_id
                                         AND bp.current_cluster = zs_curr.cluster_id
                JOIN zone_sizes zs_target ON bp.individual_id = zs_target.individual_id
                                           AND bp.neighbor_cluster = zs_target.cluster_id
                WHERE zs_target.size < zs_curr.size * 0.9
                  AND random() < 0.3
            )
            UPDATE batch_zone_grow bzg
            SET cluster_id = sc.target_cluster
            FROM swap_candidates sc
            WHERE bzg.individual_id = sc.individual_id
              AND bzg.feature_id = sc.feature_id
              AND sc.rn = 1
        """)
        self.con.execute("""
            INSERT INTO ga_assignments (individual_id, feature_id, cluster_id)
            SELECT individual_id, feature_id, cluster_id FROM batch_zone_grow
        """)

        # Clean up batch-level temp tables to free memory
        self.con.execute("DROP TABLE IF EXISTS batch_zone_grow")
        self.con.execute("DROP TABLE IF EXISTS batch_assignments")
        self.con.execute("DROP TABLE IF EXISTS zone_sizes")
        self.con.execute("DROP TABLE IF EXISTS zone_centroids_grow")
        self.con.execute("DROP TABLE IF EXISTS _new_zone_weights")
