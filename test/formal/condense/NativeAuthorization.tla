---------------- MODULE NativeAuthorization ----------------
\* Native completes/cancels without making surviving published members unprofitable.
\* Invalidation must be paired with a local revalidation barrier, not new paid work.
EXTENDS Naturals
CONSTANTS Rounds, Canceled, ScheduleAfter, AwaitLocal, EarlyGrant
VARIABLES round, phase, approved, pending, nativeRunning, requested, oversized, badOwner
vars == <<round,phase,approved,pending,nativeRunning,requested,oversized,badOwner>>
Init == /\ round=1 /\ phase="idle" /\ approved=TRUE /\ pending=FALSE /\ nativeRunning=FALSE
        /\ requested=FALSE /\ oversized=FALSE /\ badOwner=FALSE
Begin == /\ phase="idle" /\ phase'="native" /\ approved'=FALSE /\ nativeRunning'=TRUE
         /\ pending'=EarlyGrant /\ requested'=FALSE
         /\ UNCHANGED <<round,oversized,badOwner>>
End == /\ phase="native" /\ phase'=(IF Canceled THEN "cancelled" ELSE "committed") /\ nativeRunning'=FALSE
       /\ pending'=ScheduleAfter
       /\ UNCHANGED <<round,approved,requested,oversized,badOwner>>
Validate == /\ pending /\ (~nativeRunning \/ EarlyGrant) /\ approved'=TRUE /\ pending'=FALSE
            /\ badOwner'=(badOwner \/ nativeRunning)
            /\ UNCHANGED <<round,phase,nativeRunning,requested,oversized>>
Request == /\ phase \in {"cancelled","committed"} /\ (~AwaitLocal \/ ~pending)
           /\ phase'="requested" /\ requested'=TRUE /\ oversized'=(oversized \/ ~approved)
           /\ UNCHANGED <<round,approved,pending,nativeRunning,badOwner>>
\* A later settlement repairs the views, but cannot undo the request already sent raw.
Settled == /\ phase="requested" /\ phase'="settled" /\ approved'=TRUE /\ pending'=FALSE
           /\ UNCHANGED <<round,nativeRunning,requested,oversized,badOwner>>
Again == /\ phase="settled" /\ round<Rounds /\ round'=round+1 /\ phase'="idle"
         /\ UNCHANGED <<approved,pending,nativeRunning,requested,oversized,badOwner>>
Done == /\ phase="settled" /\ round=Rounds /\ UNCHANGED vars
Next == Begin \/ End \/ Validate \/ Request \/ Settled \/ Again \/ Done
Spec == Init /\ [][Next]_vars
NoRequestReinflation == ~oversized
NoGrantDuringNative == ~badOwner
=========================================================
