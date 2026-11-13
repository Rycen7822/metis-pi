---------------- MODULE ActiveRanges ----------------
\* Distinct source-row visits vs unavoidable one-pass active payload proof. Not a timing model.
\* Request-local positional indexing bounds lookup work; active payload proof and final source checks remain mandatory.
EXTENDS Naturals
CONSTANTS Rounds, Indexed, GuardFinalSource, GuardUnique, ChangeAt, DuplicateAnchors
VARIABLES round, phase, cursor, active, rows, visits, source, captured, applied, badRange
vars == <<round,phase,cursor,active,rows,visits,source,captured,applied,badRange>>
Init == /\ round=1 /\ phase="begin" /\ cursor=1 /\ active=0 /\ rows=0 /\ visits=0
        /\ source=0 /\ captured=0 /\ applied=FALSE /\ badRange=FALSE
Begin == /\ phase="begin" /\ phase'="scan" /\ active'=2*round /\ rows'=8*round+1
         /\ visits'=(IF Indexed THEN 8*round+1 ELSE 0) /\ captured'=source /\ cursor'=1 /\ applied'=FALSE
         /\ UNCHANGED <<round,source,badRange>>
Scan == /\ phase="scan" /\ cursor<=active
        /\ visits'=visits+(IF Indexed THEN 1 ELSE rows) /\ cursor'=cursor+1
        /\ phase'=(IF cursor=active THEN "count" ELSE "scan")
        /\ UNCHANGED <<round,active,rows,source,captured,applied,badRange>>
Count == /\ phase="count" /\ phase'="guard"
         /\ source'=source+(IF round=ChangeAt THEN 1 ELSE 0)
         /\ UNCHANGED <<round,cursor,active,rows,visits,captured,applied,badRange>>
Guard == /\ phase="guard" /\ phase'="checked"
         /\ applied'=((~GuardFinalSource \/ source=captured) /\ (~GuardUnique \/ ~DuplicateAnchors))
         /\ badRange'=(badRange \/ ((~GuardFinalSource \/ source=captured) /\ ~GuardUnique /\ DuplicateAnchors))
         /\ UNCHANGED <<round,cursor,active,rows,visits,source,captured>>
Again == /\ phase="checked" /\ round<Rounds /\ round'=round+1 /\ phase'="begin"
         /\ UNCHANGED <<cursor,active,rows,visits,source,captured,applied,badRange>>
Done == /\ phase="checked" /\ round=Rounds /\ UNCHANGED vars
Next == Begin \/ Scan \/ Count \/ Guard \/ Again \/ Done
Spec == Init /\ [][Next]_vars
SourceRowsNotMultiplied == phase="checked" => visits<=rows+active
NoStaleApproval == applied => source=captured
UniqueRangesOnly == ~badRange
=========================================================
