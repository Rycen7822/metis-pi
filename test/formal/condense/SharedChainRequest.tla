----------------------------- MODULE SharedChainRequest -----------------------------
\* One profitable committed block. Member selection, admission and Native ownership are modeled separately.
EXTENDS Sequences
CONSTANT Fault
VARIABLES phase, archived, source, hook, request
vars == <<phase, archived, source, hook, request>>

System == {"system-start", "system-delta", "system-edited"}
WithDelta(body, delta) == <<body, delta>>
Original == {<<"raw">>, WithDelta("raw", "system-delta")}
Edited == {<<"edited">>, WithDelta("edited", "system-delta"), WithDelta("raw", "system-edited")}
Visible(s) == SelectSeq(s, LAMBDA item: item \notin System)
Prompt == <<"system-start">> \o SelectSeq(source, LAMBDA item: item \in System)
Lead == <<"chain-start">>
Suffix == <<"chain-end", "appended-tail", "next-user">>
RawHook == Lead \o Visible(source) \o Suffix
CompactHook == Lead \o <<"shared-summary">> \o Suffix

Init == /\ phase = "published"
        /\ archived \in Original /\ source = archived
        /\ hook = <<>> /\ request = <<>>

Edit == /\ phase = "published" /\ source = archived
        /\ source' \in {s \in Edited: Len(s) = Len(archived)}
        /\ UNCHANGED <<phase, archived, hook, request>>

Project ==
    LET measured == IF Fault = "full-fingerprint" THEN archived ELSE Visible(archived)
        current == source = archived \/ Fault = "visible-only-source"
    IN /\ phase = "published" /\ phase' = "projected"
       /\ hook' = IF current /\ measured = Visible(source) THEN CompactHook ELSE RawHook
       /\ UNCHANGED <<archived, source, request>>

Send == /\ phase = "projected" /\ phase' = "sent"
        /\ request' = (IF Fault = "drop-system" THEN <<>> ELSE Prompt)
                      \o (IF Fault = "drop-tail" THEN SelectSeq(hook, LAMBDA item: item # "appended-tail") ELSE hook)
        /\ UNCHANGED <<archived, source, hook>>

Done == /\ phase = "sent" /\ UNCHANGED vars
Next == Edit \/ Project \/ Send \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

IsEvidence(item) == item \in {"shared-summary", "raw", "edited"}
Evidence == SelectSeq(request, LAMBDA item: IsEvidence(item))
SummaryDelivered == (phase = "sent" /\ source = archived) => Evidence = <<"shared-summary">>
NoStaleSummary == (phase = "sent" /\ source # archived) => Evidence = Visible(source)
ConversationPreserved == phase = "sent" =>
    SelectSeq(Visible(request), LAMBDA item: ~IsEvidence(item)) = Lead \o Suffix
SystemPreserved == phase = "sent" =>
    /\ SubSeq(request, 1, Len(Prompt)) = Prompt
    /\ SelectSeq(request, LAMBDA item: item \in System) = Prompt
EventuallySent == <>(phase = "sent")
=====================================================================================
