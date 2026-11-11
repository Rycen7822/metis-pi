---------------- MODULE EncoderMemo ----------------
\* Owner: src/condense/token-estimator.ts: snapshot queued input; cache counts only, not source fields or budget decisions.
EXTENDS Integers, Sequences, FiniteSets, TLC
CONSTANTS Steps, Capacity, SnapshotQueued, IncludeMode, IncludeAfter, FreshFields, FreshBudget, Evict, MutateQueued, ExpectedJobs
Q(b,a,m,meta,limit) == [b |-> b,a |-> a,absolute |-> m,meta |-> meta,limit |-> limit]
Repeat == <<Q(1,0,TRUE,0,5),Q(2,0,TRUE,0,5),Q(1,0,TRUE,1,5)>>
Modes == <<Q(1,0,FALSE,0,5),Q(1,0,TRUE,0,5)>>
After == <<Q(2,0,TRUE,0,5),Q(2,1,TRUE,0,5)>>
BudgetChange == <<Q(1,0,TRUE,0,20),Q(1,0,TRUE,0,5)>>
Eviction == <<Q(1,0,TRUE,0,5),Q(2,0,TRUE,0,5),Q(3,0,TRUE,0,5),Q(2,0,TRUE,0,5),Q(1,0,TRUE,0,5)>>
Key(q) == <<IF IncludeMode THEN q.absolute ELSE FALSE,q.b,IF IncludeAfter THEN q.a ELSE 0>>
F(x) == 10*x+1
Counts(q) == [delta |-> F(q.b)-F(q.a),absolute |-> q.absolute,before |-> F(q.b),after |-> F(q.a)]
Full(q) == <<q.b,q.a,q.absolute,q.meta>>
Pi(q) == 100*q.b+q.meta
Correct(c,q) == c.delta = F(q.b)-F(q.a)
               /\ (q.absolute => (c.absolute /\ c.before = F(q.b) /\ c.after = F(q.a)))
Remove(c,k) == SelectSeq(c,LAMBDA entry:entry.key # k)
VARIABLES phase, index, requested, mutable, mutated, cache, wrongCounts, wrongFields, wrongBudget, jobs
vars == <<phase,index,requested,mutable,mutated,cache,wrongCounts,wrongFields,wrongBudget,jobs>>
Init == /\ phase = "begin" /\ index = 1 /\ requested = Steps[1] /\ mutable = Steps[1] /\ mutated = FALSE
        /\ cache = <<>> /\ wrongCounts = FALSE /\ wrongFields = FALSE /\ wrongBudget = FALSE /\ jobs = 0
Begin == /\ phase = "begin" /\ index <= Len(Steps) /\ requested' = Steps[index] /\ mutable' = Steps[index]
         /\ mutated' = FALSE /\ phase' = "lookup" /\ UNCHANGED <<cache,index,wrongCounts,wrongFields,wrongBudget,jobs>>
Lookup == /\ phase = "lookup"
          /\ LET hits == SelectSeq(cache,LAMBDA entry:entry.key = Key(requested))
             IN IF Len(hits) > 0
                THEN LET entry == Head(hits)
                         fields == IF FreshFields THEN requested ELSE entry.source
                         budget == IF FreshBudget THEN requested.limit ELSE entry.source.limit
                     IN /\ cache' = Append(Remove(cache,entry.key),entry) /\ phase' = "next"
                        /\ wrongCounts' = (wrongCounts \/ ~Correct(entry.counts,requested))
                        /\ wrongFields' = (wrongFields \/ Full(fields) # Full(requested) \/ Pi(fields) # Pi(requested))
                        /\ wrongBudget' = (wrongBudget \/ (entry.counts.delta >= budget) # (entry.counts.delta >= requested.limit))
                ELSE /\ phase' = "queued" /\ UNCHANGED <<cache,wrongCounts,wrongFields,wrongBudget>>
          /\ UNCHANGED <<index,requested,mutable,mutated,jobs>>
Run == /\ phase = "queued"
       /\ LET input == IF SnapshotQueued THEN requested ELSE mutable
              counts == Counts(input)
              entry == [key |-> Key(requested),counts |-> counts,source |-> requested]
              next == Append(Remove(cache,entry.key),entry)
          IN /\ cache' = IF Evict /\ Len(next) > Capacity THEN Tail(next) ELSE next
             /\ wrongCounts' = (wrongCounts \/ ~Correct(counts,requested))
       /\ jobs' = jobs+1 /\ phase' = "next"
       /\ UNCHANGED <<index,requested,mutable,mutated,wrongFields,wrongBudget>>
Mutate == /\ phase = "queued" /\ MutateQueued /\ ~mutated /\ mutated' = TRUE
          /\ mutable' \in { [mutable EXCEPT !.b = b] : b \in 0..3 }
          /\ UNCHANGED <<phase,index,requested,cache,wrongCounts,wrongFields,wrongBudget,jobs>>
NextRequest == /\ phase = "next" /\ index' = index+1 /\ phase' = "begin"
               /\ UNCHANGED <<requested,mutable,mutated,cache,wrongCounts,wrongFields,wrongBudget,jobs>>
Done == /\ phase = "begin" /\ index > Len(Steps) /\ UNCHANGED vars
Next == Begin \/ Lookup \/ Run \/ Mutate \/ NextRequest \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"begin","lookup","queued","next"} /\ index \in 1..(Len(Steps)+1)
          /\ jobs \in 0..Len(Steps) /\ wrongCounts \in BOOLEAN /\ wrongFields \in BOOLEAN /\ wrongBudget \in BOOLEAN
Bounded == Len(cache) <= Capacity
CorrectCounts == ~wrongCounts
FreshSourceFields == ~wrongFields
FreshBudgetDecision == ~wrongBudget
QueueSnapshotSound == \A n \in 1..Len(cache) : Correct(cache[n].counts,cache[n].source)
EncodingReuse == (phase = "begin" /\ index > Len(Steps)) => jobs <= ExpectedJobs
=======================================================
