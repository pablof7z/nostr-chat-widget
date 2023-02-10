# What is NostriChat?
Nostri.chat is a chat widget you can easily embed in websites.

It uses Nostr as the underlying protocol, which permits a few pretty cool features.

## Operation Modes
### Classic chat: 1-to-1 encrypted chats
This mode implements the typical chat widget flow present in most websites. The visitor writes in the website and someone associated with the website responds.

No one else sees this communication

### Global chat: Topic/Website-based communication
In this mode, the user engages in a conversation around a topic and everybody connected to the same relays can see the communication happening and interact with it.

The communication can be scoped to one or multiple topics. (e.g. _#fasting_, _#bitcoin_, or your specific website).

When a visitor interacts with this mode, the chat widget is populated with the prior conversations that have already occurred around this topic.

> Imagine visiting a website about #fasting, and you can immediately interact with anyone interested in that topic; you can ask questions and receive immediate responses from others

# Features
- [x] NostrConnect key delegation
- [x] Ephemeral keys
- [x] Encrypted DMs mode
- [x] Tag-scoped chats mode
- [x] In-thread replies
- [ ] Root-replies mode: similar to global (publicly available) but visitor doesn't see any past history and only sees in-thread replies to the OP
