import { registerPartRenderer } from '../chat/registry';
import { PlanUpdateCard } from './PlanUpdateCard';

// A plan version appears in the chat as a card: the current one works on the plan, older ones can
// open, compare and restore their version. This import is the only thing that registers it.
registerPartRenderer('plan-update', PlanUpdateCard);
