---------------- MODULE WindowAdmission ----------------
\* Owner: SDK patch0010: selected path-order tail admission; cache retention never changes returned records.
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Shape, Capacity, Passes, Policy, Interleave, DropCold
Sizes == CASE Shape = "mixed" -> <<2,1,2,1>>
           [] Shape = "oversized" -> <<1,1,7,1>>
           [] Shape = "compaction" -> <<2,2,2,2,1>>
           [] Shape = "pinned" -> <<1,8,1,1>>
           [] OTHER -> <<1,1,1,1>>
Ids == 1..Len(Sizes)
Path == [i \in Ids |-> i]
Selected == IF Shape = "compaction" THEN <<5,3,4>> ELSE Path
Pinned == IF Shape = "pinned" THEN {2} ELSE {}
Range(s) == {s[i] : i \in 1..Len(s)}
Prefix(s) == SubSeq(s,1,Len(s)-1)
RECURSIVE Bytes(_), Trim(_), Window(_,_,_)
Bytes(s) == IF Len(s) = 0 THEN 0 ELSE Sizes[Head(s)]+Bytes(Tail(s))
Trim(s) == IF Bytes(s) <= Capacity THEN s ELSE Trim(Tail(s))
Window(s,left,selected) ==
  IF Len(s) = 0 THEN {} ELSE
  LET x == s[Len(s)] IN
  IF x \notin selected THEN Window(Prefix(s),left,selected)
  ELSE IF x \in Pinned THEN {x} \cup Window(Prefix(s),left,selected)
  ELSE IF Sizes[x] > Capacity THEN Window(Prefix(s),left,selected)
  ELSE IF Sizes[x] > left THEN {}
  ELSE {x} \cup Window(Prefix(s),left-Sizes[x],selected)
ActiveWindow == Window(Path,Capacity,Range(Selected))
BranchWindow == Window(Path,Capacity,Ids)
VARIABLES cache, phase, pass, pos, observed, misses
vars == <<cache,phase,pass,pos,observed,misses>>
Init == /\ cache = <<>> /\ phase = "read" /\ pass = 1 /\ pos = 1 /\ observed = <<>> /\ misses = 0
Read == /\ phase \in {"read","branch"}
        /\ LET order == IF phase = "read" THEN Selected ELSE Path
               x == order[pos]
               hit == x \in Pinned \/ x \in Range(cache)
               admitted == IF phase = "read" THEN ActiveWindow ELSE BranchWindow
               retain == Policy = "retain-all" \/ x \in admitted
           IN /\ pos <= Len(order)
              /\ cache' = IF x \in Pinned THEN cache
                          ELSE IF hit THEN Append(SelectSeq(cache,LAMBDA y:y # x),x)
                          ELSE IF retain /\ Sizes[x] <= Capacity THEN Trim(Append(cache,x)) ELSE cache
              /\ observed' = IF phase = "read" /\ (~DropCold \/ x \in admitted \/ x \in Pinned)
                             THEN Append(observed,x) ELSE observed
              /\ misses' = misses + IF phase = "read" /\ ~hit THEN 1 ELSE 0
        /\ pos' = pos+1 /\ UNCHANGED <<phase,pass>>
EndRead == /\ phase = "read" /\ pos > Len(Selected) /\ phase' = "checked"
           /\ UNCHANGED <<cache,pass,pos,observed,misses>>
Advance == /\ phase = "checked" /\ pass < Passes /\ pos' = 1
           /\ IF Interleave THEN /\ phase' = "branch" /\ UNCHANGED <<pass,observed,misses>>
                            ELSE /\ phase' = "read" /\ pass' = pass+1 /\ observed' = <<>> /\ misses' = 0
           /\ UNCHANGED cache
EndBranch == /\ phase = "branch" /\ pos > Len(Path) /\ phase' = "read" /\ pass' = pass+1
             /\ pos' = 1 /\ observed' = <<>> /\ misses' = 0 /\ UNCHANGED cache
Done == /\ phase = "checked" /\ pass = Passes /\ UNCHANGED vars
Next == Read \/ EndRead \/ Advance \/ EndBranch \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ cache \in Seq(Ids) /\ Len(cache) = Cardinality(Range(cache)) /\ Range(cache) \cap Pinned = {}
          /\ phase \in {"read","checked","branch"} /\ pass \in 1..Passes
          /\ pos \in 1..(Len(Path)+1) /\ observed \in Seq(Ids) /\ misses \in 0..Len(Selected)
Bounded == Bytes(cache) <= Capacity
NoDropOrReorder == phase = "checked" => observed = Selected
HotWindowSurvives == (Policy = "window" /\ ~Interleave /\ pass > 1 /\ phase = "read")
                     => ActiveWindow \ Pinned \subseteq Range(cache)
WarmMissesArePrefix == (Policy = "window" /\ ~Interleave /\ pass > 1 /\ phase = "checked")
                       => misses = Cardinality(Range(Selected) \ (ActiveWindow \cup Pinned))
NeverEvictHot == (pass > 1 /\ phase = "read") => ActiveWindow \ Pinned \subseteq Range(cache)
=========================================================
