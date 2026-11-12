---------------- MODULE RetryLifecycle ----------------
\* Owner: archiveBatches/indexer stable refs and runtime pre-request admission memo across final/context retries.
\* Three rounds; one repair/restart and one candidate/policy change. Counts are symbolic, not provider tokens.
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS StableArchive, UseMemo, MemoKey, CacheOutputFailure,
          RestartAt, DamageAt, ChangeKind, FailureKind, ManualAt
VARIABLES round, phase, source, candidate, policy, head, ref, complete, memo, seen,
          raw, published, hadComplete, writes, repeated, suppressed
vars == <<round,phase,source,candidate,policy,head,ref,complete,memo,seen,
          raw,published,hadComplete,writes,repeated,suppressed>>
Facts == <<candidate,policy>>
Key == <<IF MemoKey = "leaf" THEN head ELSE IF MemoKey = "global" THEN source ELSE candidate,policy>>
Allows == FailureKind = "output" \/ candidate > 0 \/ policy > 0
Init == /\ round = 1 /\ phase = "begin" /\ source = 0 /\ candidate = 0 /\ policy = 0 /\ head = 0
        /\ ref = 0 /\ complete = FALSE /\ memo = {} /\ seen = {} /\ raw = TRUE /\ published = FALSE
        /\ hadComplete = FALSE /\ writes = 0 /\ repeated = FALSE /\ suppressed = FALSE
Begin == /\ phase = "begin" /\ phase' = IF published THEN "finish" ELSE "archive"
         /\ source' = source + IF ChangeKind = "tail" \/ (round = 2 /\ ChangeKind = "candidate") THEN 1 ELSE 0
         /\ candidate' = candidate + IF round = 2 /\ ChangeKind = "candidate" THEN 1 ELSE 0
         /\ policy' = policy + IF round = 2 /\ ChangeKind = "policy" THEN 1 ELSE 0
         /\ complete' = (complete /\ DamageAt # round)
         /\ hadComplete' = (complete /\ DamageAt # round) /\ writes' = 0
         /\ memo' = IF RestartAt = round THEN {} ELSE memo
         /\ seen' = IF RestartAt = round THEN {} ELSE seen
         /\ UNCHANGED <<round,head,ref,raw,published,repeated,suppressed>>
Archive == /\ phase = "archive" /\ phase' = "admit"
           /\ LET needs == ~complete \/ ~StableArchive
              IN /\ ref' = IF needs /\ (~StableArchive \/ ref = 0) THEN ref+1 ELSE ref
                 /\ writes' = (IF needs THEN 1 ELSE 0)
                 /\ head' = head + (IF needs THEN 1 ELSE 0)
           /\ complete' = TRUE
           /\ UNCHANGED <<round,source,candidate,policy,memo,seen,raw,published,hadComplete,repeated,suppressed>>
Admit == /\ phase = "admit" /\ phase' = "finish"
         /\ LET hit == UseMemo /\ Key \in memo /\ ManualAt # round
                rejectedOutput == Allows /\ FailureKind = "output" /\ round = 1
                publish == ~hit /\ Allows /\ ~rejectedOutput
            IN /\ repeated' = (repeated \/ (~hit /\ ~Allows /\ Facts \in seen /\ ManualAt # round))
               /\ suppressed' = (suppressed \/ (hit /\ Allows))
               /\ memo' = IF UseMemo /\ (~Allows \/ (CacheOutputFailure /\ rejectedOutput))
                           THEN memo \cup {Key} ELSE memo
               /\ seen' = IF ~Allows THEN seen \cup {Facts} ELSE seen
               /\ published' = publish /\ raw' = ~publish
         /\ UNCHANGED <<round,source,candidate,policy,head,ref,complete,hadComplete,writes>>
NextRound == /\ phase = "finish" /\ round < 3 /\ round' = round+1 /\ phase' = "begin" /\ head' = head+1
             /\ UNCHANGED <<source,candidate,policy,ref,complete,memo,seen,raw,published,hadComplete,writes,repeated,suppressed>>
Done == /\ phase = "finish" /\ round = 3 /\ UNCHANGED vars
Next == Begin \/ Archive \/ Admit \/ NextRound \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ round \in 1..3 /\ phase \in {"begin","archive","admit","finish"}
          /\ source \in 0..3 /\ candidate \in 0..1 /\ policy \in 0..1 /\ ref \in 0..3
          /\ complete \in BOOLEAN /\ raw \in BOOLEAN /\ published \in BOOLEAN
          /\ repeated \in BOOLEAN /\ suppressed \in BOOLEAN
StableRecoveryRef == ref <= 1
NoDuplicateJournal == (phase \in {"admit","finish"} /\ hadComplete) => writes = 0
NoRedundantAdmission == ~repeated
NoSuppressedValidRetry == ~suppressed
RawOrDurableSummary == raw \/ (published /\ complete /\ ref > 0)
BoundedMemo == Cardinality(memo) <= 3
=========================================================
