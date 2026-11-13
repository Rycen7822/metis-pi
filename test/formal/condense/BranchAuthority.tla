---- MODULE BranchAuthority ----
\* Branch-owned evidence authority across repeated fork/return roundtrips.
\* The model covers resolution of branch-local refs (tN tokens for both
\* branches), cursor continuation identity and session_start-style reload.
\* A compressed shared prefix is present in every branch registry.
\* Generation counts are constants: the model explores switch/mint/page
\* orders, not generation interleavings (real probes cover those).
\* Limits: no block-ref family, no archive bytes, no continuation offsets.
EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS BranchSet, PrefixGens, LocalGens, Parts,
          RebuildOnSwitch, CursorKey, SwitchEnabled, ReloadEnabled

Branches == BranchSet
BranchNames == {"A", "B"}

PrefixToken(g) == "t" \o ToString(g)
LocalToken(g) == "t" \o ToString(PrefixGens + g)
Tokens == {PrefixToken(g) : g \in 1..PrefixGens}
          \cup {LocalToken(g) : g \in 1..LocalGens}

PrefixContents == {"p" \o ToString(g) : g \in 1..PrefixGens}
LocalContents(b) == {b \o ToString(g) : g \in 1..LocalGens}

Owner(c) == IF c \in PrefixContents
            THEN "prefix"
            ELSE CHOOSE b \in Branches : c \in LocalContents(b)

PrefixMaterial(g) == [token |-> PrefixToken(g),
                      content |-> "p" \o ToString(g),
                      owner |-> "prefix"]
LocalMaterial(b, g) == [token |-> LocalToken(g),
                        content |-> b \o ToString(g),
                        owner |-> b]
RegFor(b) == {PrefixMaterial(g) : g \in 1..PrefixGens}
             \cup {LocalMaterial(b, g) : g \in 1..LocalGens}

Matching(v, tok) == {m.content : m \in {mat \in v : mat.token = tok}}

NoCursor == [token |-> "", contents |-> {}, part |-> 0, branch |-> ""]
NoLast == [kind |-> "none"]

VARIABLES leaf, view, cursor, last

Init == /\ leaf = "A"
        /\ view = RegFor("A")
        /\ cursor = NoCursor
        /\ last = NoLast

SwitchTo(b) ==
  /\ SwitchEnabled
  /\ b \in Branches
  /\ b # leaf
  /\ leaf' = b
  /\ view' = IF RebuildOnSwitch THEN RegFor(b) ELSE view
  /\ UNCHANGED <<cursor, last>>

\* A session_start/tree reload rebuilds from the current leaf.
Reload ==
  /\ ReloadEnabled
  /\ view' = RegFor(leaf)
  /\ UNCHANGED <<leaf, cursor, last>>

\* First page of a selection; the cursor records the resolved contents.
Mint(tok) ==
  /\ tok \in Tokens
  /\ Matching(view, tok) # {}
  /\ cursor' = [token |-> tok, contents |-> Matching(view, tok),
                part |-> 0, branch |-> leaf]
  /\ last' = NoLast
  /\ UNCHANGED <<leaf, view>>

\* Continue the cursor. Selection-keyed cursors compare the whole resolved
\* contents set; a ref-only cursor accepts any current resolution.
Continue ==
  /\ cursor.token \in Tokens
  /\ cursor.part < Parts
  /\ leaf' = leaf
  /\ view' = view
  /\ LET ok == /\ Matching(view, cursor.token) # {}
              /\ (CursorKey = "selection" =>
                    Matching(view, cursor.token) = cursor.contents)
     IN IF ok
        THEN last' = [kind |-> "page", branch |-> leaf,
                      contents |-> Matching(view, cursor.token),
                      part |-> cursor.part + 1,
                      mintBranch |-> cursor.branch,
                      mintContents |-> cursor.contents,
                      mintPart |-> cursor.part]
        ELSE last' = [kind |-> "error", branch |-> leaf]
  /\ cursor' = IF cursor.part + 1 < Parts
               THEN [cursor EXCEPT !.part = cursor.part + 1]
               ELSE cursor

Next == \/ \E b \in Branches : SwitchTo(b)
        \/ Reload
        \/ \E tok \in Tokens : Mint(tok)
        \/ Continue

Spec == Init /\ [][Next]_<<leaf, view, cursor, last>>

\* Registry authority: the loaded registry never resolves another branch's
\* private evidence. Violated by a switch that keeps the stale registry.
ViewOwn == \A m \in view : Owner(m.content) \in {leaf, "prefix"}

PageOwn == IF last.kind # "page" THEN TRUE
           ELSE \A c \in last.contents : Owner(c) \in {last.branch, "prefix"}

\* A resumed page must continue exactly the material the cursor was minted
\* from; ref-only acceptance can continue a different branch's body.
ResumeSameBody == IF last.kind # "page" THEN TRUE
                  ELSE last.contents = last.mintContents
                       /\ last.part = last.mintPart + 1

\* A cursor minted on another branch may only continue the shared prefix.
ForeignCursorShared == IF last.kind # "page" THEN TRUE
                       ELSE IF last.mintBranch = last.branch THEN TRUE
                       ELSE \A c \in last.contents : Owner(c) = "prefix"

\* The compressed prefix stays resolvable in every registry.
PrefixPresent == \A g \in 1..PrefixGens :
                   \E m \in view : m.token = PrefixToken(g) /\ m.owner = "prefix"

====
