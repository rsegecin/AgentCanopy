import { Diagram } from '../diagram/Diagram';

/**
 * A fenced `mermaid` block. `closed` is false while the closing fence has not streamed in yet:
 * the source is shown as code until then, and drawn once it is complete.
 */
export function DiagramBlock({ code, closed }: { code: string; closed: boolean }) {
  return <Diagram source={code} closed={closed} />;
}
