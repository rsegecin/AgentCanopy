// Stands in for the ELK layout engine (elkjs, EPL-2.0), which AgentCanopy does not ship. Mermaid
// creates an instance when its layout code loads, but only calls it when a diagram asks for the
// "elk" layout; such a diagram then fails to draw and the diagram component shows its source
// instead. Every other layout is unaffected.
export default class ELK {
  layout() {
    return Promise.reject(new Error('The ELK layout engine is not included in AgentCanopy.'));
  }
}
