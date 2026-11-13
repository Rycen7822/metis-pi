---------------- MODULE LayeredCycles ----------------
\* Fresh generations of args/tool/shared layers; native suffix changes membership but never deletes recovery evidence.
\* Gain is a symbolic profile, not tokenizer arithmetic. JSON source/owned-summary proofs are independently modeled.
\* Native keeps 2*KeepCycles-1 units so the oldest retained group can lose just one member.
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS Cycles, Order, KeepCycles, EventKind, EventRound, GainProfile, ShapeMode,
          GuardArgs, GuardTools, GuardOwned, RelocateProtected, StableRefs
Units == 1..(2*Cycles)
Members(c) == {2*c-1,2*c}
VARIABLES round, step, phase, available, selected, archive, refs, source, protected, summary,
          args, argProof, tools, toolProof, blocks, blockProof, owned, approvals, seen, eventDone,
          badArgs, badTools, badChain, badProtection, badRecovery
vars == <<round,step,phase,available,selected,archive,refs,source,protected,summary,
          args,argProof,tools,toolProof,blocks,blockProof,owned,approvals,seen,eventDone,
          badArgs,badTools,badChain,badProtection,badRecovery>>
ArgEligible == {u \in args : u \notin protected /\ (~GuardArgs \/ argProof[u]=source[u])}
ToolEligible == {u \in tools : u \notin protected /\ (~GuardTools \/ toolProof[u]=source[u])}
ArgView == ArgEligible \cap selected
ToolView == ToolEligible \cap selected
Views(c) == {u \in Members(c) \cap selected : blockProof[c][u]=source[u]
            /\ (~GuardOwned \/ owned[c][u]=summary[u])}
Gain(c) == Views(c) # {} /\ CASE GainProfile="arg-loss" -> Views(c) \cap ArgView = {}
                                [] GainProfile="partial-loss" -> Views(c)=Members(c)
                                [] OTHER -> TRUE
Key(c) == <<c,[u \in Members(c) |-> source[u]],protected \cap Members(c),
            IF ShapeMode="without-args" THEN {} ELSE IF ShapeMode="without-window"
              THEN ArgEligible \cap Members(c) ELSE ArgView \cap Views(c),
            IF ShapeMode="without-window" THEN ToolEligible \cap Members(c) ELSE ToolView \cap Views(c),
            IF ShapeMode="without-window" THEN Members(c) ELSE Views(c),
            [u \in Members(c) |-> summary[u]]>>
Used == {c \in blocks : Views(c) # {} /\ approvals[c]=Key(c)}
ChainHidden == UNION {Views(c) : c \in Used}
Init == /\ round=1 /\ step=1 /\ phase="begin" /\ available={} /\ selected={} /\ archive={}
        /\ refs=[u \in Units |-> 0] /\ source=[u \in Units |-> 0] /\ protected={} /\ summary=[u \in Units |-> 0]
        /\ args={} /\ argProof=[u \in Units |-> 0] /\ tools={} /\ toolProof=[u \in Units |-> 0] /\ blocks={}
        /\ blockProof=[c \in 1..Cycles |-> [u \in Units |-> 0]]
        /\ owned=[c \in 1..Cycles |-> [u \in Units |-> 0]] /\ approvals=[c \in 1..Cycles |-> <<>>]
        /\ seen={} /\ eventDone=FALSE /\ badArgs=FALSE /\ badTools=FALSE /\ badChain=FALSE
        /\ badProtection=FALSE /\ badRecovery=FALSE
Begin == /\ phase="begin" /\ phase'="ops" /\ available'=available \cup Members(round)
         /\ selected'=selected \cup Members(round) /\ archive'=archive \cup Members(round)
         /\ refs'=[u \in Units |-> IF u \in Members(round) THEN u ELSE refs[u]]
         /\ UNCHANGED <<round,step,source,protected,summary,args,argProof,tools,toolProof,blocks,blockProof,
                        owned,approvals,seen,eventDone,badArgs,badTools,badChain,badProtection,badRecovery>>
Interfere == /\ phase="ops" /\ round=EventRound /\ step=1 /\ ~eventDone /\ EventKind # "none"
             /\ LET target == IF round=1 THEN 1 ELSE 2*round-2 IN
                /\ source'=[source EXCEPT ![target]=@+(IF EventKind="source" THEN 1 ELSE 0)]
                /\ protected'=IF EventKind="protection" THEN protected \cup {target} ELSE protected
                /\ summary'=[summary EXCEPT ![target]=@+(IF EventKind="summary" THEN 1 ELSE 0)]
             /\ approvals'=IF EventKind="restore" THEN [c \in 1..Cycles |-> <<>>] ELSE approvals
             /\ eventDone'=TRUE
             /\ UNCHANGED <<round,step,phase,available,selected,archive,refs,args,argProof,tools,toolProof,
                            blocks,blockProof,owned,seen,badArgs,badTools,badChain,badProtection,badRecovery>>
Compress == /\ phase="ops" /\ step<=4 /\ phase'="render"
            /\ LET digit == (Order \div (10^(4-step))) % 10
                   kind == CASE digit=1 -> "args" [] digit=2 -> "tool" [] digit=3 -> "chain" [] OTHER -> "native"
                   candidates == (Members(round) \cap selected) \ protected
               IN /\ args'=IF kind="args" THEN args \cup candidates ELSE args
                  /\ argProof'=IF kind="args" THEN [u \in Units |-> IF u \in candidates THEN source[u] ELSE argProof[u]] ELSE argProof
                  /\ tools'=IF kind="tool" THEN tools \cup candidates ELSE tools
                  /\ toolProof'=IF kind="tool" THEN [u \in Units |-> IF u \in candidates THEN source[u] ELSE toolProof[u]] ELSE toolProof
                  /\ summary'=IF kind="tool" THEN [u \in Units |-> IF u \in candidates THEN summary[u]+1 ELSE summary[u]] ELSE summary
                  /\ blocks'=IF kind="chain" THEN blocks \cup {round} ELSE blocks
                  /\ blockProof'=IF kind="chain" THEN [blockProof EXCEPT ![round]=source] ELSE blockProof
                  /\ owned'=IF kind="chain" THEN [owned EXCEPT ![round]=summary] ELSE owned
                  /\ selected'=IF kind="native" THEN {u \in available : u>2*(round-KeepCycles)+1} ELSE selected
                  /\ refs'=IF ~StableRefs /\ kind="native" THEN [u \in Units |-> IF u \in archive THEN refs[u]+1 ELSE 0] ELSE refs
                  /\ seen'=seen \cup {kind}
            /\ UNCHANGED <<round,step,available,archive,source,protected,approvals,eventDone,
                           badArgs,badTools,badChain,badProtection,badRecovery>>
Render == /\ phase="render" /\ phase'="approve"
          /\ badArgs'=(badArgs \/ \E u \in ArgView : argProof[u] # source[u])
          /\ badTools'=(badTools \/ \E u \in ToolView : toolProof[u] # source[u])
          /\ badChain'=(badChain \/ \E c \in Used : ~Gain(c) \/ \E u \in Views(c):owned[c][u] # summary[u])
          /\ badProtection'=(badProtection \/ (~RelocateProtected /\ ChainHidden \cap protected # {}))
          /\ badRecovery'=(badRecovery \/ (ArgView \cup ToolView \cup ChainHidden) \ archive # {})
          /\ UNCHANGED <<round,step,available,selected,archive,refs,source,protected,summary,args,argProof,
                         tools,toolProof,blocks,blockProof,owned,approvals,seen,eventDone>>
Approve == /\ phase="approve" /\ phase'="advance"
           /\ approvals'=[c \in 1..Cycles |-> IF c \in blocks /\ Gain(c) THEN Key(c) ELSE <<>>]
           /\ UNCHANGED <<round,step,available,selected,archive,refs,source,protected,summary,args,argProof,
                          tools,toolProof,blocks,blockProof,owned,seen,eventDone,badArgs,badTools,badChain,badProtection,badRecovery>>
Advance == /\ phase="advance"
           /\ IF step<4 THEN /\ step'=step+1 /\ phase'="ops" /\ UNCHANGED round
              ELSE IF round<Cycles THEN /\ round'=round+1 /\ step'=1 /\ phase'="begin"
              ELSE /\ phase'="done" /\ UNCHANGED <<round,step>>
           /\ UNCHANGED <<available,selected,archive,refs,source,protected,summary,args,argProof,tools,toolProof,
                          blocks,blockProof,owned,approvals,seen,eventDone,badArgs,badTools,badChain,badProtection,badRecovery>>
Next == Begin \/ Interfere \/ Compress \/ Render \/ Approve \/ Advance \/ (phase="done" /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
TypeOK == /\ round \in 1..Cycles /\ step \in 1..4 /\ selected \subseteq available
          /\ archive \subseteq available /\ args \subseteq archive /\ tools \subseteq archive /\ blocks \subseteq 1..Cycles
NoStaleArgs == ~badArgs
NoStaleTools == ~badTools
NoUnjustifiedChain == ~badChain
ProtectedEvidenceVisible == ~badProtection
RecoveryComplete == ~badRecovery
StableHistoricalRefs == \A u \in archive : refs[u]=u
FullCycleWitness == phase="done" => seen={"args","tool","chain","native"}
=========================================================
