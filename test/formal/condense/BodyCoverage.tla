---------------- MODULE BodyCoverage ----------------
\* Test contract: a reused synthetic identity is not proof of complete current member coverage.
\* Normal callers start from fresh source; derived replay is a separate unconfirmed caller contract.
EXTENDS Naturals, FiniteSets
CONSTANTS Rounds, FreshSource, KeepRawOnMismatch
Members == {1,2,3}
Wanted(r) == CASE r%3=1 -> {1} [] r%3=2 -> {1,2} [] OTHER -> Members
VARIABLES round, phase, raw, body, hidden, marker
vars == <<round,phase,raw,body,hidden,marker>>
Init == /\ round=1 /\ phase="begin" /\ raw=Members /\ body={} /\ hidden={} /\ marker=FALSE
Begin == /\ phase="begin" /\ phase'="apply"
         /\ raw'=(IF FreshSource THEN Members ELSE raw)
         /\ body'=(IF FreshSource THEN {} ELSE body)
         /\ hidden'=(IF FreshSource THEN {} ELSE hidden)
         /\ marker'=(IF FreshSource THEN FALSE ELSE marker)
         /\ UNCHANGED round
Apply == /\ phase="apply" /\ phase'="checked" /\ marker'=TRUE
         /\ LET cover == IF ~marker THEN body \cup Wanted(round) ELSE body
                canDrop == IF KeepRawOnMismatch THEN Wanted(round) \cap cover ELSE Wanted(round)
            IN /\ body'=cover /\ raw'=raw \ canDrop /\ hidden'=hidden \cup canDrop
         /\ UNCHANGED round
Again == /\ phase="checked" /\ round<Rounds /\ round'=round+1 /\ phase'="begin"
         /\ UNCHANGED <<raw,body,hidden,marker>>
Done == /\ phase="checked" /\ round=Rounds /\ UNCHANGED vars
Next == Begin \/ Apply \/ Again \/ Done
Spec == Init /\ [][Next]_vars
NoHiddenWithoutBody == hidden \subseteq body
EvidenceVisibleOrRepresented == raw \cup body=Members
=========================================================
