---------------- MODULE PublicationTxn ----------------
\* Owner: src/condense/runtime.ts: capture before waits; synchronous full source/policy/lifecycle guard at commit.
EXTENDS Naturals, TLC
CONSTANTS MaxChanges, EarlyCapture, AtomicCommit, GuardMode, ArchiveComplete, HasGain, BudgetAllows
VARIABLES phase, source, policy, life, head, changes, captured, requestSource, approved,
          published, freshAtPublish, rebased, inline
vars == <<phase,source,policy,life,head,changes,captured,requestSource,approved,
          published,freshAtPublish,rebased,inline>>
Init == /\ phase = "capture" /\ source = 0 /\ policy = 0 /\ life = 0 /\ head = 0 /\ changes = 0
        /\ captured = <<0,0,0,0>> /\ requestSource = 0 /\ approved = FALSE
        /\ published = FALSE /\ freshAtPublish = TRUE /\ rebased = FALSE /\ inline = TRUE
Capture == /\ phase = "capture" /\ phase' = "work"
           /\ captured' = IF EarlyCapture THEN <<source,policy,life,head>> ELSE <<MaxChanges+1,0,0,0>>
           /\ UNCHANGED <<source,policy,life,head,changes,requestSource,approved,published,freshAtPublish,rebased,inline>>
LateCapture == /\ phase = "work" /\ captured[1] = MaxChanges+1
               /\ captured' = <<source,policy,life,head>> /\ phase' = "ready"
               /\ UNCHANGED <<source,policy,life,head,changes,requestSource,approved,published,freshAtPublish,rebased,inline>>
Complete == /\ phase = "work" /\ captured[1] <= MaxChanges /\ phase' = "ready"
            /\ UNCHANGED <<source,policy,life,head,changes,captured,requestSource,approved,
                           published,freshAtPublish,rebased,inline>>
Fresh == source = captured[1] /\ policy = captured[2] /\ life = captured[3]
Guard == CASE GuardMode = "full" -> Fresh
           [] GuardMode = "head" -> head = captured[4] /\ policy = captured[2] /\ life = captured[3]
           [] GuardMode = "without-policy" -> source = captured[1] /\ life = captured[3]
           [] GuardMode = "without-life" -> source = captured[1] /\ policy = captured[2]
           [] GuardMode = "none" -> TRUE
Allowed == ArchiveComplete /\ HasGain /\ BudgetAllows
Validate == /\ phase = "ready" /\ ~AtomicCommit /\ approved' = Guard /\ phase' = "validated"
            /\ UNCHANGED <<source,policy,life,head,changes,captured,requestSource,published,
                           freshAtPublish,rebased,inline>>
Commit == /\ ((phase = "ready" /\ AtomicCommit) \/ phase = "validated")
          /\ LET accept == Allowed /\ (IF AtomicCommit THEN Guard ELSE approved)
             IN /\ phase' = "done" /\ published' = accept /\ inline' = ~accept
                /\ freshAtPublish' = (~accept \/ Fresh)
                /\ rebased' = (accept /\ captured[1] # requestSource)
          /\ UNCHANGED <<source,policy,life,head,changes,captured,requestSource,approved>>
Change(kind) == /\ phase \in {"work","ready","validated"} /\ changes < MaxChanges
                /\ changes' = changes+1
                /\ source' = source + IF kind \in {"body","append"} THEN 1 ELSE 0
                /\ head' = head + IF kind \in {"metadata","append"} THEN 1 ELSE 0
                /\ policy' = policy + IF kind = "policy" THEN 1 ELSE 0
                /\ life' = life + IF kind = "life" THEN 1 ELSE 0
                /\ UNCHANGED <<phase,captured,requestSource,approved,published,freshAtPublish,rebased,inline>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == Capture \/ LateCapture \/ Complete \/ Validate \/ Commit
        \/ (\E kind \in {"body","append","metadata","policy","life"} : Change(kind)) \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"capture","work","ready","validated","done"} /\ source \in 0..MaxChanges
          /\ policy \in 0..MaxChanges /\ life \in 0..MaxChanges /\ head \in 0..MaxChanges
          /\ changes \in 0..MaxChanges /\ captured \in [1..4 -> 0..(MaxChanges+1)] /\ requestSource = 0
          /\ approved \in BOOLEAN /\ published \in BOOLEAN /\ freshAtPublish \in BOOLEAN
          /\ rebased \in BOOLEAN /\ inline \in BOOLEAN
NoStalePublish == freshAtPublish
NoRebase == ~rebased
NoLossOnDeferral == ~published => inline
NoUnsafeReplacement == published => Allowed
NoFalseReject == (phase = "done" /\ Allowed /\ Fresh) => published
NeverPublishes == ~published
========================================================
