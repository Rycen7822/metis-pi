-------------------------- MODULE VerdictEpoch --------------------------
\* Shared gain verdicts are stamped witnesses. A positive verdict authorizes
\* only while the current projection shape equals its stamp; a failed count
\* leaves no verdict. Constants seed which epoch inputs the stamp covers and
\* whether policy/model boundaries clear immediately. Abstract state only:
\* no token counts, no millisecond or allocation claims.
EXTENDS Naturals

CONSTANTS Mode, MaxRounds, FaultRound,
          IncludePolicy, IncludeSource, IncludeOwner, IncludeProtect, IncludeModel,
          ClearOnPolicy, ClearOnModel, TreatFailureAsNegative

VARIABLES policy, source, owner, protect, model, verdict, stamp, round, phase, failed

vars == <<policy, source, owner, protect, model, verdict, stamp, round, phase, failed>>

Shape == (IF IncludePolicy THEN 1 ELSE 0) * (IF policy THEN 1 ELSE 0)
       + (IF IncludeSource THEN 2 ELSE 0) * (IF source THEN 1 ELSE 0)
       + (IF IncludeOwner THEN 4 ELSE 0) * (IF owner THEN 1 ELSE 0)
       + (IF IncludeProtect THEN 8 ELSE 0) * (IF protect THEN 1 ELSE 0)
       + (IF IncludeModel THEN 16 ELSE 0) * (IF model THEN 1 ELSE 0)

Gain == CASE Mode = "policy"  -> policy
          [] Mode = "source"  -> source
          [] Mode = "owner"   -> owner
          [] Mode = "protect" -> protect
          [] Mode = "model"   -> model
          [] Mode = "always"  -> TRUE
          [] OTHER            -> FALSE

Authorized == verdict = "pos" /\ stamp = Shape

Init == policy = TRUE /\ source = TRUE /\ owner = TRUE /\ protect = TRUE /\ model = TRUE
        /\ verdict = "none" /\ stamp = 99 /\ round = 0 /\ phase = "mutate" /\ failed = FALSE

MutatePolicy == /\ phase = "mutate"
                /\ policy' = ~policy
                /\ verdict' = (IF ClearOnPolicy THEN "none" ELSE verdict)
                /\ phase' = "measure"
                /\ UNCHANGED <<source, owner, protect, model, stamp, round, failed>>

MutateSource == /\ phase = "mutate"
                /\ source' = ~source
                /\ phase' = "measure"
                /\ UNCHANGED <<policy, owner, protect, model, verdict, stamp, round, failed>>

MutateOwner == /\ phase = "mutate"
               /\ owner' = ~owner
               /\ phase' = "measure"
               /\ UNCHANGED <<policy, source, protect, model, verdict, stamp, round, failed>>

MutateProtect == /\ phase = "mutate"
                 /\ protect' = ~protect
                 /\ phase' = "measure"
                 /\ UNCHANGED <<policy, source, owner, model, verdict, stamp, round, failed>>

MutateModel == /\ phase = "mutate"
               /\ model' = ~model
               /\ verdict' = (IF ClearOnModel THEN "none" ELSE verdict)
               /\ phase' = "measure"
               /\ UNCHANGED <<policy, source, owner, protect, stamp, round, failed>>

PostPolicy == /\ phase = "post" /\ round + 1 < MaxRounds
              /\ policy' = ~policy
              /\ verdict' = (IF ClearOnPolicy THEN "none" ELSE verdict)
              /\ phase' = "post"
              /\ UNCHANGED <<source, owner, protect, model, stamp, round, failed>>

PostSource == /\ phase = "post" /\ round + 1 < MaxRounds
              /\ source' = ~source
              /\ phase' = "post"
              /\ UNCHANGED <<policy, owner, protect, model, verdict, stamp, round, failed>>

PostOwner == /\ phase = "post" /\ round + 1 < MaxRounds
             /\ owner' = ~owner
             /\ phase' = "post"
             /\ UNCHANGED <<policy, source, protect, model, verdict, stamp, round, failed>>

PostProtect == /\ phase = "post" /\ round + 1 < MaxRounds
               /\ protect' = ~protect
               /\ phase' = "post"
               /\ UNCHANGED <<policy, source, owner, model, verdict, stamp, round, failed>>

PostModel == /\ phase = "post" /\ round + 1 < MaxRounds
             /\ model' = ~model
             /\ verdict' = (IF ClearOnModel THEN "none" ELSE verdict)
             /\ phase' = "post"
             /\ UNCHANGED <<policy, source, owner, protect, stamp, round, failed>>

Measure == /\ phase = "measure"
           /\ failed' = (round = FaultRound)
           /\ stamp' = Shape
           /\ verdict' = (IF round = FaultRound
                            THEN (IF TreatFailureAsNegative THEN "neg" ELSE "none")
                            ELSE (IF Gain THEN "pos" ELSE "neg"))
           /\ phase' = "post"
           /\ UNCHANGED <<policy, source, owner, protect, model, round>>

Observe == /\ phase = "post"
           /\ phase' = "observe"
           /\ UNCHANGED <<policy, source, owner, protect, model, verdict, stamp, round, failed>>

NextRound == /\ phase = "observe" /\ round + 1 < MaxRounds
             /\ round' = round + 1
             /\ phase' = "mutate"
             /\ UNCHANGED <<policy, source, owner, protect, model, verdict, stamp, failed>>

Done == /\ phase = "observe" /\ round + 1 = MaxRounds
        /\ UNCHANGED vars

Next == MutatePolicy \/ MutateSource \/ MutateOwner \/ MutateProtect \/ MutateModel
     \/ PostPolicy \/ PostSource \/ PostOwner \/ PostProtect \/ PostModel
     \/ Measure \/ Observe \/ NextRound \/ Done

Spec == Init /\ [][Next]_vars

TypeOK == /\ round \in 0..MaxRounds
          /\ phase \in {"mutate", "measure", "post", "observe"}
          /\ verdict \in {"none", "pos", "neg"}
          /\ stamp \in 0..99
          /\ failed \in BOOLEAN

NoStaleAuthority == Authorized => Gain
FailedNotCached == failed => verdict = "none"
NoNegativeAuthority == verdict = "neg" => ~Authorized
SettledGain == (phase = "observe" /\ round + 1 = MaxRounds /\ ~failed) => (Authorized <=> Gain)

=============================================================================
