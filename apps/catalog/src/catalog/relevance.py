"""How a browse list is ordered: by the published topic score."""

#: The score the harvester publishes, HIGHER IS BETTER. Ordering reads this and
#: never a tier name: the harvester owns that vocabulary, and a rename or a new
#: tier there must not need a release here.
TOPIC_SCORE_FIELD = "goat:topicRelevanceScore"

#: What an unscored row gets: the bottom of the published scale. Nothing known
#: is worth no more than known-to-be-marginal, and no less.
UNGRADED_RELEVANCE = 1

RELEVANCE_RANK_SQL = f'COALESCE("{TOPIC_SCORE_FIELD}", {UNGRADED_RELEVANCE})'

BBOX_AREA_SQL = (
    "COALESCE(CASE WHEN"
    " GREATEST(bbox_xmax - bbox_xmin, bbox_ymax - bbox_ymin) > 100 THEN 0"
    " ELSE (bbox_xmax - bbox_xmin) * (bbox_ymax - bbox_ymin) END, 0)"
)
