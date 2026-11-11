---------------- MODULE PressureGrid ----------------
\* Owner: src/condense/budget.ts: local inclusive pressure, unclamped growth, known native headroom and strict native limit.
EXTENDS Integers, TLC
CONSTANTS CapBeforePercent, ClampGrowth
Windows == {300000,400000,500000,600000,700000,800000,900000,1000000}
Profiles == UNION {
 { [window |-> w, cap |-> c, native |-> n, reserve |-> s, pct |-> p] :
   c \in {300000,w}, n \in {"off","known","unknown"}, s \in {0,16384,100000}, p \in {-1,0,50,70,100} } : w \in Windows }
Min(a,b) == IF a < b THEN a ELSE b
MinSet(s) == CHOOSE x \in s : \A y \in s : x <= y
Relative(r) == CASE r.pct = 50 -> r.window \div 2 [] r.pct = 70 -> (7*r.window) \div 10 [] OTHER -> r.window
Expected(r) == MinSet({r.cap,Relative(r)} \cup
                     IF r.native = "known" THEN {r.window-r.reserve-16384} ELSE {})
Previous(r) == r.window-(r.cap \div 10)
DeltaAt(r) == Previous(r)+(r.cap \div 20)
Samples(r) == {x \in {0,1,r.window-1,r.window,r.window+1,Expected(r)-1,Expected(r),Expected(r)+1,
 r.window-r.reserve-1,r.window-r.reserve,r.window-r.reserve+1,DeltaAt(r)-1,DeltaAt(r),DeltaAt(r)+1,
 r.cap-1,r.cap,r.cap+1} : x >= 0}
VARIABLES row, tokens, known, prior
vars == <<row,tokens,known,prior>>
Init == /\ row \in Profiles /\ tokens \in Samples(row) /\ known \in BOOLEAN /\ prior \in BOOLEAN
Next == UNCHANGED vars
Spec == Init /\ [][Next]_vars
NativeGate == IF row.native = "known" THEN 100*(row.window-row.reserve-16384) ELSE 1000000000
Gate == Min(NativeGate,IF CapBeforePercent THEN row.pct*row.cap ELSE Min(100*row.cap,row.pct*row.window))
Level == known /\ row.pct > 0 /\ tokens*100 >= Gate
Growth == known /\ prior /\ (IF ClampGrowth THEN Min(tokens,row.cap)-Min(Previous(row),row.cap)
                            ELSE tokens-Previous(row))*100 >= 5*row.cap
LevelBoundary == Level = (known /\ row.pct > 0 /\ tokens >= Expected(row))
DeltaBoundary == Growth = (known /\ prior /\ tokens >= DeltaAt(row))
NoUnknownPaid == ~known => ~Level
NativeStrict == (row.native # "off" /\ known /\ tokens > row.window-row.reserve)
                = (row.native # "off" /\ known /\ tokens >= row.window-row.reserve+1)
TypeOK == /\ row \in Profiles /\ tokens \in Samples(row) /\ known \in BOOLEAN /\ prior \in BOOLEAN
======================================================
