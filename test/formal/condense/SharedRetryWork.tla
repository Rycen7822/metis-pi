---------------- MODULE SharedRetryWork ----------------
\* Abstract source-row visits and final full-source guards, not milliseconds or allocations.
\* Negative verdicts authorize nothing; profitable approvals still need a current source guard.
EXTENDS Naturals
CONSTANTS Cycles, GuardRejected, GuardPublish, IndexActiveBlocks, CacheVerdict, HasGain, MutateDuringCount
VARIABLES round, phase, blocks, active, measured, checks, visits, memo,
          source, captured, approved
vars == <<round,phase,blocks,active,measured,checks,visits,memo,source,captured,approved>>
Init == /\ round=1 /\ phase="generate" /\ blocks=0 /\ active=1 /\ measured=0 /\ checks=0 /\ visits=0
        /\ memo=FALSE /\ source=0 /\ captured=0 /\ approved=FALSE
Generate == /\ phase="generate" /\ phase'="measure" /\ blocks'=blocks+1 /\ checks'=0
            /\ visits'=IF IndexActiveBlocks THEN active*2 ELSE blocks'*2
            /\ approved'=FALSE
            /\ UNCHANGED <<round,active,measured,memo,source,captured>>
Measure == /\ phase="measure" /\ phase'="validate" /\ captured'=source
           /\ measured'=measured+(IF ~HasGain /\ CacheVerdict /\ memo THEN 0 ELSE 1)
           /\ memo'=~HasGain /\ source'=source+(IF HasGain /\ MutateDuringCount THEN 1 ELSE 0)
           /\ UNCHANGED <<round,blocks,active,checks,visits,approved>>
Validate == /\ phase="validate" /\ phase'="checked"
            /\ checks'=IF HasGain THEN (IF GuardPublish THEN 1 ELSE 0) ELSE (IF GuardRejected THEN 1 ELSE 0)
            /\ approved'=(HasGain /\ (~GuardPublish \/ source=captured))
            /\ UNCHANGED <<round,blocks,active,measured,visits,memo,source,captured>>
Again == /\ phase="checked" /\ round<Cycles /\ round'=round+1 /\ phase'="generate"
         /\ UNCHANGED <<blocks,active,measured,checks,visits,memo,source,captured,approved>>
Done == /\ phase="checked" /\ round=Cycles /\ UNCHANGED vars
Next == Generate \/ Measure \/ Validate \/ Again \/ Done
Spec == Init /\ [][Next]_vars
NoFullGuardForRejectedView == ~HasGain => checks=0
WarmSourceWorkBound == visits<=active*2
NoDuplicateCountWork == ~HasGain => measured<=1
NoStaleApproval == approved => captured=source
=========================================================
