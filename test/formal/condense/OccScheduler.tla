---------------- MODULE OccScheduler ----------------
\* Owner: src/condense/occ.ts; ready is transient, phase is normal/waiting/hold; reuse is floored.
EXTENDS Naturals, Sequences, TLC
CONSTANTS Steps, InitialPhase, InitialAtWork, InitialAtChars, InitialExhausted, IgnoreNear, PhysicalDenominator, Window, Reserve
Max(a,b) == IF a > b THEN a ELSE b
P(t,w,c,d,p) == [tokens |-> t, work |-> w, chars |-> c, expected |-> d,
  phase |-> IF p = "ready" THEN "waiting" ELSE p, expectReady |-> p = "ready",
  window |-> 100000, reserve |-> 0, native |-> TRUE, known |-> TRUE, capability |-> TRUE,
  observations |-> 3, growth |-> 100, spent |-> FALSE, newRequest |-> FALSE]
HoldBoth == <<P(60000,7,130000,TRUE,"hold"),P(60000,8,114999,TRUE,"hold"),
 P(60000,8,115000,TRUE,"waiting"),P(72000,9,116000,TRUE,"ready")>>
ExpireReenter == <<P(60000,4,100000,TRUE,"waiting"),P(60000,7,103000,FALSE,"normal"),
 P(60000,8,104000,FALSE,"normal"),P(72000,9,105000,TRUE,"ready"),P(72000,10,106000,TRUE,"ready")>>
FloorHorizon == <<[P(98950,4,100000,FALSE,"normal") EXCEPT !.native = FALSE],
 [P(98900,4,100000,TRUE,"waiting") EXCEPT !.native = FALSE]>>
EarlyWaiting == <<P(60000,3,100000,TRUE,"waiting"),P(72000,4,101000,TRUE,"ready")>>
NativeDisabled == <<[P(600000,4,100000,TRUE,"waiting") EXCEPT
 !.native = FALSE, !.window = 1000000, !.reserve = 600000]>>
Limit == Window-Reserve
CeilPct(p) == (p*Limit+99) \div 100
A(t,w,d,p) == [P(t,w,100000+w*1000,d,p) EXCEPT !.window = Window, !.reserve = Reserve]
WindowScenario == <<A(CeilPct(60)-1,4,FALSE,"normal"), A(CeilPct(60),4,TRUE,"waiting"),
 A(CeilPct(72)-1,5,TRUE,"waiting"), A(CeilPct(72),5,TRUE,"ready"),
 A(CeilPct(52)-1,5,FALSE,"normal"), A(CeilPct(60),6,FALSE,"normal"),
 A(CeilPct(72),6,TRUE,"ready"), A(CeilPct(95)-1,6,TRUE,"ready"),
 A(CeilPct(95),6,FALSE,"normal"), A(Limit,6,FALSE,"normal"), A(Limit+1,6,TRUE,"normal"),
 [A(CeilPct(60),7,TRUE,"waiting") EXCEPT !.newRequest = TRUE]>>
VARIABLES state, index, wrong, wait, ready
vars == <<state,index,wrong,wait,ready>>
Init == /\ state = [phase |-> InitialPhase, atWork |-> InitialAtWork, atChars |-> InitialAtChars,
                    exhausted |-> InitialExhausted, capacityWaiting |-> FALSE]
        /\ index = 1 /\ wrong = FALSE /\ wait = FALSE /\ ready = FALSE
Decision(s,p) ==
 LET capKnown == p.native /\ p.window-p.reserve > 0
     limit == IF capKnown THEN p.window-p.reserve ELSE p.window
     denom == IF PhysicalDenominator THEN p.window ELSE limit
     capWait == capKnown /\ p.known /\ p.tokens > limit
     initial == [s EXCEPT !.capacityWaiting = capWait,
       !.phase = IF capWait # s.capacityWaiting /\ s.phase = "waiting" THEN "normal" ELSE s.phase,
       !.exhausted = IF p.newRequest THEN FALSE ELSE s.exhausted]
     held == initial.phase = "hold" /\ (p.work-initial.atWork < 4
       \/ (p.chars-initial.atChars)*100 < Max(500000,15*initial.atChars))
     base == IF initial.phase = "hold" /\ ~held THEN [initial EXCEPT !.phase = "normal"] ELSE initial
     isNear == capKnown /\ p.known /\ (limit-p.tokens)*100 <= Max(102400,5*limit)
     unavailable == ~p.known \/ ~p.capability \/ p.observations < 3
     economic == limit-p.tokens >= 11*p.growth
     enter == IF base.phase = "normal" /\ p.tokens*100 >= (IF base.exhausted THEN 72 ELSE 60)*denom /\ ~p.spent
              THEN [base EXCEPT !.phase = "waiting", !.atWork = IF base.exhausted THEN base.atWork ELSE p.work] ELSE base
     isReady == enter.phase = "waiting" /\ p.tokens*100 >= 72*denom
                /\ p.work-enter.atWork >= 1 /\ p.work >= 4 /\ ~p.spent
     expire == IF enter.phase = "waiting" /\ ~isReady /\ p.work-enter.atWork >= 3
               THEN [enter EXCEPT !.phase = "normal", !.exhausted = TRUE] ELSE enter
 IN CASE capWait -> [s |-> initial, waiting |-> TRUE, ready |-> FALSE]
      [] held -> [s |-> initial, waiting |-> TRUE, ready |-> FALSE]
      [] isNear /\ ~IgnoreNear -> [s |-> [base EXCEPT !.phase = IF base.phase = "waiting" THEN "normal" ELSE base.phase],
                                    waiting |-> FALSE, ready |-> FALSE]
      [] unavailable \/ ~economic -> [s |-> base, waiting |-> FALSE, ready |-> FALSE]
      [] base.phase = "waiting" /\ p.tokens*100 < 52*denom ->
           [s |-> [base EXCEPT !.phase = "normal", !.exhausted = TRUE], waiting |-> FALSE, ready |-> FALSE]
      [] OTHER -> [s |-> expire, waiting |-> expire.phase = "waiting", ready |-> isReady]
Step == /\ index <= Len(Steps)
        /\ LET p == Steps[index] d == Decision(state,p)
           IN /\ state' = d.s /\ wait' = d.waiting /\ ready' = d.ready
              /\ wrong' = (wrong \/ d.waiting # p.expected \/ d.s.phase # p.phase \/ d.ready # p.expectReady)
        /\ index' = index+1
Done == /\ index > Len(Steps) /\ UNCHANGED vars
Next == Step \/ Done
Spec == Init /\ [][Next]_vars
ExpectedTransitions == ~wrong
TypeOK == /\ state.phase \in {"normal","waiting","hold"} /\ index \in 1..(Len(Steps)+1)
          /\ wrong \in BOOLEAN /\ wait \in BOOLEAN /\ ready \in BOOLEAN
==================================================
