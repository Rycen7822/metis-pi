---------------- MODULE AsyncReaders ----------------
\* Owner: SDK patch0010 session-entry-store/session-manager: owned buffers, epoch/selection checks and finally-close.
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS ReaderCount, Records, MaxChanges, GuardEpoch, PostClose, GuardManager, OwnBuffers,
          CloseHandles, CheckAbort, AllowFault
Readers == 1..ReaderCount
VARIABLES epoch, store, leaf, changes, r, buffer
vars == <<epoch,store,leaf,changes,r,buffer>>
Init == /\ epoch = 0 /\ store = 0 /\ leaf = 0 /\ changes = 0
        /\ buffer = [i \in Readers |-> [id |-> 0, version |-> 0]]
        /\ r = [i \in Readers |-> [pc |-> "new", index |-> 1, e |-> 0, s |-> 0, l |-> 0,
          fd |-> FALSE, values |-> <<>>, aborted |-> FALSE, invalid |-> FALSE, fault |-> FALSE,
          integrity |-> FALSE, outcome |-> "none", selection |-> TRUE, closeFresh |-> TRUE, closedEpoch |-> 0]]
Set(i,value) == /\ r' = [r EXCEPT ![i] = value] /\ UNCHANGED <<epoch,store,leaf,changes,buffer>>
Begin(i) == /\ r[i].pc = "new"
            /\ Set(i,[r[i] EXCEPT !.pc = "read", !.e = epoch, !.s = store, !.l = leaf])
Read(i) == /\ r[i].pc = "read" /\ r[i].index <= Records
           /\ IF r[i].aborted THEN Set(i,[r[i] EXCEPT !.pc = "close"])
              ELSE IF GuardEpoch /\ r[i].e # epoch THEN Set(i,[r[i] EXCEPT !.pc = "close", !.invalid = TRUE])
              ELSE Set(i,[r[i] EXCEPT !.pc = "pending", !.fd = TRUE])
IO(i) == /\ r[i].pc = "pending"
         /\ buffer' = [buffer EXCEPT ![IF OwnBuffers THEN i ELSE 1] = [id |-> r[i].index, version |-> epoch]]
         /\ r' = [r EXCEPT ![i].pc = "decode"] /\ UNCHANGED <<epoch,store,leaf,changes>>
Decode(i) == /\ r[i].pc = "decode"
             /\ LET bytes == buffer[IF OwnBuffers THEN i ELSE 1]
                IN IF r[i].aborted THEN Set(i,[r[i] EXCEPT !.pc = "close"])
                   ELSE IF GuardEpoch /\ r[i].e # epoch
                        THEN Set(i,[r[i] EXCEPT !.pc = "close", !.invalid = TRUE])
                   ELSE IF bytes.id # r[i].index
                        THEN Set(i,[r[i] EXCEPT !.pc = "close", !.integrity = TRUE])
                   ELSE Set(i,[r[i] EXCEPT !.pc = "read", !.index = @+1, !.values = Append(@,bytes.version)])
ReadDone(i) == /\ r[i].pc = "read" /\ r[i].index > Records /\ Set(i,[r[i] EXCEPT !.pc = "close"])
Close(i) == /\ r[i].pc = "close"
            /\ Set(i,[r[i] EXCEPT !.fd = IF CloseHandles THEN FALSE ELSE @,
               !.pc = IF r[i].fault \/ r[i].integrity \/ r[i].invalid THEN "return" ELSE "post"])
CheckClosed(i) == /\ r[i].pc = "post"
                  /\ Set(i,[r[i] EXCEPT !.pc = "return", !.closedEpoch = epoch,
                     !.invalid = (@ \/ (GuardEpoch /\ PostClose /\ r[i].e # epoch))])
Return(i) == /\ r[i].pc = "return"
             /\ LET mismatch == r[i].s # store \/ r[i].l # leaf
                    fallback == r[i].invalid \/ (GuardManager /\ mismatch)
                    stopped == CheckAbort /\ r[i].aborted
                IN Set(i,[r[i] EXCEPT !.pc = "done",
                   !.outcome = IF stopped THEN "abort" ELSE IF fallback THEN "ok"
                               ELSE IF r[i].fault \/ r[i].integrity THEN "error" ELSE "ok",
                   !.values = IF fallback /\ ~stopped THEN [n \in 1..Records |-> epoch] ELSE @,
                   !.selection = (fallback \/ ~mismatch),
                   !.closeFresh = (fallback \/ r[i].e = r[i].closedEpoch)])
Fault(i) == /\ AllowFault /\ r[i].pc = "pending"
            /\ Set(i,[r[i] EXCEPT !.pc = "close", !.fault = TRUE])
Abort(i) == /\ r[i].pc # "done" /\ ~r[i].aborted /\ Set(i,[r[i] EXCEPT !.aborted = TRUE])
Mutate(kind) == /\ changes < MaxChanges /\ (\E i \in Readers : r[i].pc # "done")
                /\ changes' = changes+1
                /\ epoch' = epoch + IF kind = "rewrite" THEN 1 ELSE 0
                /\ store' = store + IF kind = "reload" THEN 1 ELSE 0
                /\ leaf' = leaf + IF kind = "branch" THEN 1 ELSE 0
                /\ UNCHANGED <<r,buffer>>
Advance(i) == Begin(i) \/ Read(i) \/ IO(i) \/ Decode(i) \/ ReadDone(i) \/ Close(i) \/ CheckClosed(i) \/ Return(i)
Done == /\ (\A i \in Readers : r[i].pc = "done") /\ UNCHANGED vars
Next == (\E i \in Readers : Advance(i) \/ Fault(i) \/ Abort(i))
        \/ (\E kind \in {"rewrite","reload","branch"} : Mutate(kind)) \/ Done
UnfairSpec == Init /\ [][Next]_vars
Spec == UnfairSpec /\ (\A i \in Readers : WF_vars(Advance(i)))
TypeOK == /\ epoch \in 0..MaxChanges /\ store \in 0..MaxChanges /\ leaf \in 0..MaxChanges
          /\ changes \in 0..MaxChanges /\ DOMAIN r = Readers /\ DOMAIN buffer = Readers
          /\ \A i \in Readers : /\ r[i].pc \in {"new","read","pending","decode","close","post","return","done"}
                                /\ r[i].index \in 1..(Records+1) /\ r[i].values \in Seq(0..MaxChanges)
                                /\ Len(r[i].values) <= Records /\ r[i].fd \in BOOLEAN
NoTornResult == \A i \in Readers : r[i].outcome = "ok" =>
  (Len(r[i].values) = Records /\ Cardinality({r[i].values[n] : n \in 1..Len(r[i].values)}) <= 1)
NoWrongSelection == \A i \in Readers : r[i].outcome = "ok" => r[i].selection
NoSpuriousIntegrity == \A i \in Readers : ~r[i].integrity
NoLeak == \A i \in Readers : r[i].pc = "done" => ~r[i].fd
CancelledNoSuccess == \A i \in Readers : r[i].aborted => r[i].outcome # "ok"
CloseEpochRespected == \A i \in Readers : r[i].outcome = "ok" => r[i].closeFresh
NoMaskedFault == \A i \in Readers : (r[i].fault /\ ~r[i].invalid /\ r[i].s = store /\ r[i].l = leaf)
                 => r[i].outcome # "ok"
EventuallyFinishes == <> (\A i \in Readers : r[i].pc = "done")
========================================================
