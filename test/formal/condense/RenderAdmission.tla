---------------- MODULE RenderAdmission ----------------
\* Persisted same-source shared views need local validation, independent of paid-work admission.
\* Native running/source invalidation is excluded here; LayeredCycles and PublicationTxn retain those guards.
EXTENDS Naturals
CONSTANTS GatePublished, GateNewWork, RecheckOnRestore, ReportedTokens, NativeLimit
CurrentCapacity == ReportedTokens>NativeLimit
VARIABLES phase, published, approved, waiting, applied, newWork, heldAtValidation
vars == <<phase,published,approved,waiting,applied,newWork,heldAtValidation>>
Init == /\ phase=0 /\ published=TRUE /\ approved=TRUE /\ waiting=FALSE /\ applied=TRUE
        /\ newWork=FALSE /\ heldAtValidation=FALSE
PersistHold == /\ phase=0 /\ phase'=1 /\ waiting'=TRUE
               /\ UNCHANGED <<published,approved,applied,newWork,heldAtValidation>>
Resume == /\ phase=1 /\ phase'=2 /\ approved'=FALSE /\ applied'=FALSE
          /\ waiting'=IF RecheckOnRestore THEN CurrentCapacity ELSE waiting
          /\ UNCHANGED <<published,newWork,heldAtValidation>>
Validate == /\ phase=2 /\ phase'=3 /\ heldAtValidation'=waiting
            /\ approved'=(published /\ (~GatePublished \/ ~waiting))
            /\ newWork'=(~GateNewWork \/ ~waiting)
            /\ UNCHANGED <<published,waiting,applied>>
Request == /\ phase=3 /\ phase'=4 /\ waiting'=CurrentCapacity /\ applied'=approved
           /\ UNCHANGED <<published,approved,newWork,heldAtValidation>>
Done == /\ phase=4 /\ UNCHANGED vars
Next == PersistHold \/ Resume \/ Validate \/ Request \/ Done
Spec == Init /\ [][Next]_vars
PublishedViewPreserved == phase=4 => applied=published
NoNewWorkWhileHeld == heldAtValidation => ~newWork
=========================================================
