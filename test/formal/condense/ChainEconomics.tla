---------------- MODULE ChainEconomics ----------------
\* Reference admission contract for runtime.ts chain publication, not a production-policy implementation.
EXTENDS Integers, FiniteSets, TLC
CONSTANTS Initial, Limit, Requests, Cadence, Gains, Growths, Stable, Retained,
          ColdPrice, ReadPrice, Policy, ColdAt
ASSUME /\ Initial > Stable /\ Stable >= 0 /\ Limit >= Initial /\ Requests > 0 /\ Cadence > 0
       /\ Gains # {} /\ Growths # {} /\ Gains \subseteq Nat /\ Growths \subseteq Nat
       /\ ColdPrice >= ReadPrice /\ ReadPrice > 0 /\ Retained >= 0 /\ ColdAt >= 0
       /\ Policy \in {"funded","gain-only","input-credit"}
ConstantSavings == {3000}
MixedSavings == {2000,80000}
BatchSavings == {80000}
LateSavings == {4700}
SteadyGrowth == {5000}
VariableGrowth == {1000,20000}
SmallGrowth == {1000}
BatchGrowth == {20000}
Max(a,b) == IF a > b THEN a ELSE b
Min(a,b) == IF a < b THEN a ELSE b
MaxGrowth == CHOOSE g \in Growths : \A h \in Growths : h <= g
VARIABLE s
vars == <<s>>
Init == s = [tick |-> 0, phase |-> "offer", raw |-> Initial, saved |-> 0,
  valid |-> Initial, rawValid |-> Initial, frontier |-> Stable, pending |-> 0, members |-> 0,
  cost |-> 0, baseCost |-> 0, rewrites |-> 0, lowHits |-> 0, largestBatch |-> 0,
  unfunded |-> FALSE, forced |-> 0, comparable |-> TRUE, handoff |-> FALSE]
\* An offer is a newly eligible closed chain; local loop indices are not provider turn counts.
Offer == /\ s.phase = "offer" /\ s.tick < Requests
         /\ \E g \in Gains :
              s' = [s EXCEPT !.phase = "decide",
                !.pending = @+IF s.tick % Cadence = 0 THEN g ELSE 0,
                !.members = @+IF s.tick % Cadence = 0 THEN 1 ELSE 0,
                !.valid = IF s.tick+1 = ColdAt THEN 0 ELSE @,
                !.rawValid = IF s.tick+1 = ColdAt THEN 0 ELSE @]
Cut == Min(s.valid,s.frontier)
\* Removed warm tokens save the read price, not the cold-input price; never pre-spend future requests.
Penalty == Max(0,s.valid-Cut-s.pending)*(ColdPrice-ReadPrice)
Gate == CASE Policy = "gain-only" -> TRUE
          [] Policy = "input-credit" -> s.pending*ColdPrice >= Penalty
          [] OTHER -> s.pending*ReadPrice >= Penalty
FitsCandidate == s.pending > 0 /\ s.pending+s.members*Retained <= s.raw-s.saved-s.frontier
Pressure == s.raw-s.saved+MaxGrowth > Limit
Commit == /\ s.phase = "decide" /\ FitsCandidate /\ (Pressure \/ Gate)
          /\ s' = [s EXCEPT !.phase = "request", !.saved = @+s.pending, !.valid = Cut,
               !.frontier = @+s.members*Retained, !.pending = 0, !.members = 0,
               !.rewrites = @+1, !.largestBatch = Max(@,s.members),
               !.unfunded = (@ \/ (~Pressure /\ s.pending*ReadPrice < Penalty)),
               !.forced = @+IF Pressure THEN 1 ELSE 0, !.comparable = @ /\ ~Pressure]
Defer == /\ s.phase = "decide" /\ ~(FitsCandidate /\ (Pressure \/ Gate))
         /\ s' = [s EXCEPT !.phase = "request"]
Request == /\ s.phase = "request"
           /\ \E g \in Growths :
                LET rawNext == s.raw+g
                    input == rawNext-s.saved
                    cached == Min(s.valid,input)
                    rawCached == Min(s.rawValid,rawNext)
                IN /\ input <= Limit
                   /\ s' = [s EXCEPT !.tick = @+1, !.raw = rawNext,
                        !.phase = IF s.tick+1 = Requests THEN "done" ELSE "offer",
                        !.valid = input, !.rawValid = rawNext,
                        !.cost = @+cached*ReadPrice+(input-cached)*ColdPrice,
                        !.baseCost = @+rawCached*ReadPrice+(rawNext-rawCached)*ColdPrice,
                        !.lowHits = @+IF cached*100 < input*10 THEN 1 ELSE 0,
                        !.comparable = @ /\ rawNext <= Limit]
\* A capacity rescue is outside the optional-cost claim; Native is neither free nor forbidden.
NativeHandoff == /\ s.phase = "request" /\ s.raw-s.saved+MaxGrowth > Limit
                 /\ s' = [s EXCEPT !.phase = "done", !.handoff = TRUE, !.comparable = FALSE]
Done == /\ s.phase = "done" /\ UNCHANGED vars
Next == Offer \/ Commit \/ Defer \/ Request \/ NativeHandoff \/ Done
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Next)
TypeOK == /\ s.tick \in 0..Requests /\ s.phase \in {"offer","decide","request","done"}
          /\ s.raw >= s.saved /\ s.valid >= 0 /\ s.rawValid >= 0 /\ s.pending >= 0
          /\ s.cost >= 0 /\ s.baseCost >= 0 /\ s.rewrites >= s.forced
FinalCostDominance == s.phase # "done" \/ ~s.comparable \/ s.cost <= s.baseCost
OnlineCostDominance == ~s.comparable \/ s.cost <= s.baseCost
NoUnfundedRewrite == ~s.unfunded
NoRepeatedLowHit == s.lowHits < 2
NoOptionalRewriteWitness == s.rewrites = s.forced
NoForcedRewriteWitness == s.forced = 0
NoBatchWitness == s.largestBatch <= 1
NoHandoffWitness == ~s.handoff
EventuallyDone == <>(s.phase = "done")
=======================================================
