------------------------- MODULE NativeFragments -------------------------
\* Abstract Native (host compaction) firstKept boundaries over ordered tool
\* groups. A group is user, assistant tool calls, results..., final assistant.
\* Argument history is complete-assistant+results only; a chain range also
\* needs its unique visible user start and visible final assistant.
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Groups, Calls, StartCut, ReuseBare, CollideAnchors,
          OverwriteBare, PartialPublish, IgnoreAnchor, AllowCut

VARIABLES firstKept, published, ranges, argsArchive, edited, appliedArgs, appliedRanges
vars == <<firstKept, published, ranges, argsArchive, edited, appliedArgs, appliedRanges>>

PerGroup == 3 + Calls
Total == Groups * PerGroup

UserPos(g) == g * PerGroup
AssistantPos(g) == g * PerGroup + 1
ResultPos(g, r) == g * PerGroup + 2 + r
FinalPos(g) == g * PerGroup + 2 + Calls

Visible(pos) == pos >= firstKept
VisibleUser(g) == UserPos(g) >= firstKept
VisibleAssistant(g) == AssistantPos(g) >= firstKept
VisibleResult(g, r) == ResultPos(g, r) >= firstKept
VisibleFinal(g) == FinalPos(g) >= firstKept

CompleteAt(g, k) == AssistantPos(g) >= k
  /\ \A r \in 0..Calls-1: ResultPos(g, r) >= k
HasAnyAt(g, k) == AssistantPos(g) >= k
  \/ \E r \in 0..Calls-1: ResultPos(g, r) >= k
Complete(g) == CompleteAt(g, firstKept)

NewestAt(g, k) == AssistantPos(g) >= k
  /\ \A h \in (g + 1)..(Groups - 1): AssistantPos(h) < k

Anchor(g) == IF CollideAnchors THEN 7 ELSE 7 + g
UniqueAnchorAt(g, k) == \A h \in 0..Groups-1:
  h # g => ~(UserPos(h) >= k /\ Anchor(h) = Anchor(g))

ArgsTag(g, r) == g * 10 + r
OutTag(g, r) == g * 100 + r

BareKey(g, r) == IF ReuseBare THEN <<0, r>> ELSE <<g, r>>
Key(g, r) == IF OverwriteBare THEN BareKey(g, r) ELSE <<g, r>>

\* Archive only bodies the current visible span actually exposes.
ArchivedCalls(g) == {r \in 0..Calls-1: CompleteAt(g, firstKept) \/ VisibleResult(g, r)}
NewArchive(g) ==
  {rec \in argsArchive: \A r \in 0..Calls-1: rec.key # Key(g, r)}
  \cup {[key |-> Key(g, r), group |-> g, call |-> r,
         argsTag |-> ArgsTag(g, r), outTag |-> OutTag(g, r)]: r \in ArchivedCalls(g)}

ApplyArgs(pub, k, ed) == {g \in pub: CompleteAt(g, k) /\ g \notin ed}
ApplyRanges(rs, k, ed) == {g \in rs: UserPos(g) >= k /\ FinalPos(g) >= k
  /\ (UniqueAnchorAt(g, k) \/ IgnoreAnchor) /\ g \notin ed}


Init == /\ firstKept = StartCut
        /\ published = {}
        /\ ranges = {}
        /\ argsArchive = {}
        /\ edited = {}
        /\ appliedArgs = {}
        /\ appliedRanges = {}

PublishArg(g) ==
  /\ g \in 0..Groups-1
  /\ g \notin published
  /\ g \notin edited
  /\ HasAnyAt(g, firstKept)
  /\ ~NewestAt(g, firstKept)
  /\ (Complete(g) \/ PartialPublish)
  /\ (Complete(g) \/ HasAnyAt(g, firstKept))
  /\ published' = published \cup {g}
  /\ argsArchive' = NewArchive(g)
  /\ appliedArgs' = ApplyArgs(published \cup {g}, firstKept, edited)
  /\ UNCHANGED <<firstKept, ranges, edited, appliedRanges>>

PublishRange(g) ==
  /\ g \in 0..Groups-1
  /\ g \notin ranges
  /\ g \notin edited
  /\ VisibleUser(g)
  /\ VisibleFinal(g)
  /\ (UniqueAnchorAt(g, firstKept) \/ IgnoreAnchor)
  /\ ranges' = ranges \cup {g}
  /\ appliedRanges' = ApplyRanges(ranges \cup {g}, firstKept, edited)
  /\ UNCHANGED <<firstKept, published, argsArchive, edited, appliedArgs>>

Cut(k) ==
  /\ AllowCut
  /\ k \in 0..Total
  /\ firstKept' = k
  /\ appliedArgs' = ApplyArgs(published, k, edited)
  /\ appliedRanges' = ApplyRanges(ranges, k, edited)
  /\ UNCHANGED <<published, ranges, argsArchive, edited>>

EditSource(g) ==
  /\ g \in 0..Groups-1
  /\ edited' = edited \cup {g}
  /\ appliedArgs' = ApplyArgs(published, firstKept, edited \cup {g})
  /\ appliedRanges' = ApplyRanges(ranges, firstKept, edited \cup {g})
  /\ UNCHANGED <<firstKept, published, ranges, argsArchive>>

Resume == /\ appliedArgs' = ApplyArgs(published, firstKept, edited)
          /\ appliedRanges' = ApplyRanges(ranges, firstKept, edited)
          /\ UNCHANGED <<firstKept, published, ranges, argsArchive, edited>>

Next == \/ \E g \in 0..Groups-1: PublishArg(g)
        \/ \E g \in 0..Groups-1: PublishRange(g)
        \/ \E k \in 0..Total: Cut(k)
        \/ \E g \in 0..Groups-1: EditSource(g)
        \/ Resume

Spec == Init /\ [][Next]_vars

AppliedArgsComplete == \A g \in appliedArgs:
  CompleteAt(g, firstKept) /\ g \notin edited
AppliedArgsEligible == appliedArgs = ApplyArgs(published, firstKept, edited)
ArchiveAllCalls == \A g \in published: \A r \in 0..Calls-1:
  \E rec \in argsArchive: rec.group = g /\ rec.call = r
ArchiveExact == \A rec \in argsArchive:
  rec.argsTag = ArgsTag(rec.group, rec.call) /\ rec.outTag = OutTag(rec.group, rec.call)
TailUncompressed == \A g \in appliedArgs: ~NewestAt(g, firstKept)
RangesCurrent == \A g \in appliedRanges:
  UserPos(g) >= firstKept /\ FinalPos(g) >= firstKept /\ g \notin edited
RangesAnchored == \A g \in appliedRanges: UniqueAnchorAt(g, firstKept)
=========================================================================
