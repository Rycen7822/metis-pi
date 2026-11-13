---------------- MODULE ColdBoundary ----------------
\* Reference cold-boundary permission for chain admission; request/source epochs are ghost identities.
EXTENDS Naturals, TLC
CONSTANTS Steps, Fault
VARIABLE s
vars == <<s>>
Init == s = [step |-> 0, source |-> 0, era |-> 0, cache |-> "hot", native |-> "idle",
  plan |-> FALSE, planSource |-> 0, planEra |-> 0, planCold |-> FALSE,
  lastWasCold |-> FALSE, bad |-> FALSE, commits |-> 0]
More == s.step < Steps
BeginNative == /\ More /\ s.native = "idle"
               /\ s' = [s EXCEPT !.step = @+1, !.native = "running"]
\* This completed Native actually changes the common prefix; not every completion must do so.
CompleteNative == /\ More /\ s.native = "running"
                  /\ s' = [s EXCEPT !.step = @+1, !.native = "complete", !.cache = "cold",
                       !.source = @+1, !.era = @+1]
CancelNative == /\ More /\ s.native = "running"
                /\ s' = [s EXCEPT !.step = @+1, !.native = "cancelled"]
ColdFact == s.cache = "cold" \/ (Fault = "planned-cold" /\ s.native = "running")
            \/ (Fault = "last-hit-cold" /\ s.lastWasCold)
Prepare == /\ More /\ ~s.plan
           /\ s' = [s EXCEPT !.step = @+1, !.plan = TRUE, !.planSource = s.source,
                !.planEra = s.era, !.planCold = ColdFact]
Publish == /\ More /\ s.plan /\ s.planCold /\ s.native # "running"
           /\ s.planSource = s.source /\ (Fault = "ignore-warm-epoch" \/ s.planEra = s.era)
           /\ s' = [s EXCEPT !.step = @+1, !.plan = FALSE, !.commits = @+1,
                !.bad = (@ \/ s.cache = "hot")]
Reconsider == /\ More /\ s.plan
              /\ s' = [s EXCEPT !.step = @+1, !.plan = FALSE]
\* Low hit rate describes the completed request; the next request can now have a hot prefix.
MainRequest == /\ More /\ s.native # "running"
               /\ s' = [s EXCEPT !.step = @+1, !.lastWasCold = s.cache = "cold",
                    !.cache = "hot", !.era = @+1]
Done == /\ s.step = Steps /\ UNCHANGED vars
Next == BeginNative \/ CompleteNative \/ CancelNative \/ Prepare \/ Publish \/ Reconsider \/ MainRequest \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.step \in 0..Steps /\ s.source \in 0..1 /\ s.era \in 0..Steps
          /\ s.cache \in {"hot","cold"} /\ s.native \in {"idle","running","complete","cancelled"}
NoUnfundedPublish == ~s.bad
NoProgressWitness == s.commits = 0
=====================================================
