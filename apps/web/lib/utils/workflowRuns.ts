type RunNode = { id: string; data?: { type?: string } };
type RunEdge = { source: string; target: string };

/**
 * Whether a run of the workflow does anything, as the runner and the workflow
 * check see it: it runs each tool step, and saves what is connected to an
 * export step, a dataset's rows too. Run is offered only then.
 */
export function workflowRunsSomething(nodes: RunNode[], edges: RunEdge[]): boolean {
  if (nodes.some((node) => node.data?.type === "tool")) return true;
  const ids = new Set(nodes.map((node) => node.id));
  const exports = new Set(nodes.filter((node) => node.data?.type === "export").map((node) => node.id));
  return edges.some((edge) => ids.has(edge.source) && exports.has(edge.target));
}
