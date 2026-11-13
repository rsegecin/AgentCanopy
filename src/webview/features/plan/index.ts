import { registerPartRenderer } from '../chat/registry';
import { PlanUpdateCard } from './PlanUpdateCard';

export { PlanView } from './PlanView';

// A new plan version appears in the chat as a card with ways to open, compare and revert it.
registerPartRenderer('plan-update', PlanUpdateCard);
