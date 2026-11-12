---------------- MODULE DeferredGuards ----------------
\* Owner: runtime flushPending schedule/completeRecord. Count whole-source checks, never milliseconds.
\* Ordered-result abstraction; provider concurrency is covered by pipeline tests and PublicationTxn.
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Batches, GuardPlacement, AtomicGuard, PublishAt, MutateAt, LeadingTrivial, RespectGap
VARIABLES round, batch, phase, source, captured, reads, pureWaste, hidden, stale, frontier, frontierReads, mutated
vars == <<round,batch,phase,source,captured,reads,pureWaste,hidden,stale,frontier,frontierReads,mutated>>
Kind(b) == IF b = PublishAt THEN "publish"
           ELSE IF (LeadingTrivial /\ b = 1) \/ b % 5 \in {3,4} THEN "trivial" ELSE "deferred"
Init == /\ round = 1 /\ batch = 1 /\ phase = "loop-pre" /\ source = 0 /\ captured = 0 /\ reads = 1
        /\ pureWaste = 0 /\ hidden = {} /\ stale = FALSE /\ frontier = 0 /\ frontierReads = 0 /\ mutated = FALSE
Guard(at) == /\ phase = at
             /\ reads' = reads + (IF GuardPlacement = "all" THEN 1 ELSE 0)
             /\ pureWaste' = pureWaste + (IF GuardPlacement = "all" /\ Kind(batch) = "deferred" THEN 1 ELSE 0)
             /\ phase' = IF at = "loop-pre" THEN "prepare" ELSE "commit"
             /\ UNCHANGED <<round,batch,source,captured,hidden,stale,frontier,frontierReads,mutated>>
Prepare == /\ phase = "prepare" /\ phase' = "loop-post"
           /\ reads' = reads + (IF GuardPlacement = "all" /\ Kind(batch) # "trivial" THEN 1 ELSE 0)
           /\ pureWaste' = pureWaste + (IF GuardPlacement = "all" /\ Kind(batch) = "deferred" THEN 1 ELSE 0)
           /\ UNCHANGED <<round,batch,source,captured,hidden,stale,frontier,frontierReads,mutated>>
Change == /\ phase = "commit" /\ batch = MutateAt /\ ~mutated /\ source' = source+1 /\ mutated' = TRUE
          /\ UNCHANGED <<round,batch,phase,captured,reads,pureWaste,hidden,stale,frontier,frontierReads>>
Commit == /\ phase = "commit"
          /\ LET publishes == Kind(batch) = "publish"
                 allowed == ~AtomicGuard \/ source = captured
                 progress == Kind(batch) # "deferred" /\ (~RespectGap \/ batch = frontier+1)
                 advances == progress /\ allowed
              IN /\ hidden' = IF publishes /\ allowed THEN hidden \cup {batch} ELSE hidden
                 /\ stale' = (stale \/ ((publishes \/ advances) /\ allowed /\ source # captured))
                 /\ reads' = reads + (IF AtomicGuard /\ (publishes \/
                      (Kind(batch) = "trivial" /\ (GuardPlacement = "all" \/ progress))) THEN 1 ELSE 0)
                 /\ frontierReads' = frontierReads + (IF progress /\ Kind(batch) = "trivial" THEN 1 ELSE 0)
                 /\ frontier' = IF advances THEN batch ELSE frontier
          /\ phase' = IF batch = Batches THEN "checked" ELSE "loop-pre"
          /\ batch' = IF batch = Batches THEN batch ELSE batch+1
          /\ UNCHANGED <<round,source,captured,pureWaste,mutated>>
Retry == /\ phase = "checked" /\ round < 3 /\ round' = round+1 /\ batch' = 1 /\ phase' = "loop-pre"
         /\ source' = source+1 /\ captured' = source+1 /\ reads' = 1 /\ pureWaste' = 0 /\ frontierReads' = 0
         /\ UNCHANGED <<hidden,stale,frontier,mutated>>
Done == /\ phase = "checked" /\ round = 3 /\ UNCHANGED vars
Next == Guard("loop-pre") \/ Prepare \/ Guard("loop-post") \/ Change \/ Commit \/ Retry \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ round \in 1..3 /\ batch \in 1..Batches
          /\ phase \in {"loop-pre","prepare","loop-post","commit","checked"}
          /\ hidden \subseteq 1..Batches /\ frontier \in 0..Batches /\ stale \in BOOLEAN
NoStaleCommit == ~stale
NeverHideDeferred == \A b \in hidden : Kind(b) = "publish"
NoDeferredFrontier == \A b \in 1..frontier : Kind(b) # "deferred"
NoGuardOnRejectedPlan == pureWaste = 0
BoundedNoGainReplay == (PublishAt = 0 /\ phase = "checked") => reads <= 1+frontierReads
=========================================================
