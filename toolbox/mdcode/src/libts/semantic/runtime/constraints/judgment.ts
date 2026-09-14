// Checking a constraint that is settled by judgment.
//
// A `judgment` states the rule in words, for the rules no expression decides:
// *the credit memo must name a specific service failure* is a real requirement
// with a real owner, and no arithmetic settles it. The store cannot answer
// one, so no dialect helps; what answers it is a language model reading the
// attempted call against the rule's own text.
//
// Planning one is turning the rule into a question. It does not ask -- no
// checker does, and a judge costs a network round trip, so an action must be
// reportable as runnable without spending one. What planning does need is to
// know that SOMETHING will answer, which is why a missing judge is refused
// here rather than discovered at run time: a guard nothing can settle must
// fail to plan, or `whyRefusedWithoutRunning` would call the action runnable
// and the runtime would meet an unanswerable rule with the transaction open.
//
// A `warn` rule still passes, because index.ts reports an advisory rule it
// cannot check rather than refusing over it.

import {cannotCheck, CheckPlan, ConstraintChecker} from './check';


/** The checker for a constraint stated as a judgment. */
export const judgedCheck: ConstraintChecker =
    ({action, constraint, judge}): CheckPlan => {
      if (!judge) {
        return cannotCheck(
            constraint,
            `it is settled by judgment rather than by an expression, and ` +
                `this runtime was given no judge to ask`);
      }
      // Validation rejects an empty judgment at load time. A model that
      // reached here another way -- pulled from a catalog, built in code --
      // would otherwise send a judge an empty rule, which it would answer.
      const rule = constraint.judgment?.trim();
      if (!rule) {
        return cannotCheck(
            constraint, `its judgment is empty, so there is nothing to ask`);
      }
      return {
        ok: true,
        check: {
          settledBy: 'judge',
          constraint,
          rule,
          // Every parameter, because the rule is prose and nothing here can
          // tell which of them it speaks about. A store check names the
          // parameters it wrote into its SQL; a judge is shown the call.
          parameters: action.parameters.map(p => p.name),
        },
      };
    };
