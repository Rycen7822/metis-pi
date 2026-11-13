---------------- MODULE RecoveryCycles ----------------
\* Ref/own-args identity is execution-scoped even when bare provider IDs and output text are reused.
\* Native prefix removal retires inactive queue gaps, not recovery records in the session journal.
EXTENDS Naturals, FiniteSets
CONSTANTS Cycles, KeepRounds, DeferredAt, CrashRound, CrashStep, FailKind,
          ArchiveFirst, RestoreFromArchive, OwnAliasMetadata, StableRefs, DropRecovery, GuardFrontier
Units == 1..Cycles
VARIABLES round, step, phase, window, archive, everArchive, refs, ownArgs, summaries, memory,
          gaps, frontier, crashed, badFrontier
vars == <<round,step,phase,window,archive,everArchive,refs,ownArgs,summaries,memory,gaps,frontier,crashed,badFrontier>>
Init == /\ round=1 /\ step=1 /\ phase="begin" /\ window={} /\ archive={} /\ everArchive={}
        /\ refs=[u \in Units |-> 0] /\ ownArgs=[u \in Units |-> 0] /\ summaries={} /\ memory={}
        /\ gaps={} /\ frontier=0 /\ crashed=FALSE /\ badFrontier=FALSE
Begin == /\ phase="begin" /\ phase'="op" /\ window'=window \cup {round}
         /\ UNCHANGED <<round,step,archive,everArchive,refs,ownArgs,summaries,memory,gaps,frontier,crashed,badFrontier>>
Write == /\ phase="op" /\ phase'="check"
         /\ LET persisted == step=1 /\ ~(round=CrashRound /\ FailKind="payload")
                semantic == step=2 /\ round # DeferredAt /\ ~(round=CrashRound /\ FailKind="summary")
                            /\ (~ArchiveFirst \/ round \in archive)
                advance == step=3 /\ round \in summaries
                           /\ (~GuardFrontier \/ {u \in gaps \cap window : u<=round}={})
                nextWindow == IF step=4 THEN {u \in 1..round : u>round-KeepRounds} ELSE window
             IN /\ archive'=IF step=4 /\ DropRecovery THEN archive \cap nextWindow
                            ELSE IF persisted THEN archive \cup {round} ELSE archive
                /\ everArchive'=IF persisted THEN everArchive \cup {round} ELSE everArchive
                /\ refs'=IF persisted THEN [refs EXCEPT ![round]=IF StableRefs THEN round ELSE round+Cycles] ELSE refs
                /\ ownArgs'=IF persisted THEN [ownArgs EXCEPT ![round]=IF OwnAliasMetadata THEN round ELSE 1] ELSE ownArgs
                /\ summaries'=IF semantic THEN summaries \cup {round} ELSE summaries
                /\ memory'=IF semantic THEN memory \cup {round} ELSE memory
                /\ gaps'=IF step=2 /\ ~semantic THEN gaps \cup {round} ELSE gaps
                /\ frontier'=IF advance /\ ~(round=CrashRound /\ FailKind="frontier") THEN round ELSE frontier
                /\ badFrontier'=(badFrontier \/ (advance /\ {u \in gaps \cap window : u<round} # {}))
                /\ window'=nextWindow
         /\ UNCHANGED <<round,step,crashed>>
Crash == /\ phase="check" /\ round=CrashRound /\ step=CrashStep /\ ~crashed /\ phase'="restore" /\ crashed'=TRUE
         /\ UNCHANGED <<round,step,window,archive,everArchive,refs,ownArgs,summaries,memory,gaps,frontier,badFrontier>>
Restore == /\ phase="restore" /\ phase'="check"
           /\ memory'=IF RestoreFromArchive THEN archive ELSE summaries
           /\ UNCHANGED <<round,step,window,archive,everArchive,refs,ownArgs,summaries,gaps,frontier,crashed,badFrontier>>
Advance == /\ phase="check"
           /\ IF step<4 THEN /\ step'=step+1 /\ phase'="op" /\ UNCHANGED round
              ELSE IF round<Cycles THEN /\ round'=round+1 /\ step'=1 /\ phase'="begin"
              ELSE /\ phase'="done" /\ UNCHANGED <<round,step>>
           /\ UNCHANGED <<window,archive,everArchive,refs,ownArgs,summaries,memory,gaps,frontier,crashed,badFrontier>>
Next == Begin \/ Write \/ Crash \/ Restore \/ Advance \/ (phase="done" /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
TypeOK == /\ round \in 1..Cycles /\ step \in 1..4 /\ window \subseteq 1..round /\ frontier \in 0..Cycles
NoArchiveAuthority == memory \subseteq summaries
RecoveryBeforeHiding == memory \subseteq archive
HistoricalRecoverySurvives == everArchive \subseteq archive
StableOccurrenceRefs == \A u \in archive : refs[u]=u
OwnExecutionArguments == \A u \in archive : ownArgs[u]=u
NoVisibleGapLeap == ~badFrontier
AllHistoricalGapsBlockForever == \A u \in gaps : u>frontier
=========================================================
