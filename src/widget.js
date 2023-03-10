import Widget from './Widget.svelte';

var div = document.createElement('DIV');
var script = document.currentScript;
const websiteOwnerPubkey = script.getAttribute('data-website-owner-pubkey');
const chatType = script.getAttribute('data-chat-type');
let chatTags = script.getAttribute('data-chat-tags');
let chatReferenceTags = script.getAttribute('data-chat-reference-tags');
let relays = script.getAttribute('data-relays');
let includeTagsInMessage = script.getAttribute('data-include-tags-in-message');
let includeUrlInMessage = script.getAttribute('data-include-url-in-message');
script.parentNode.insertBefore(div, script);

if (!relays) {
	relays = 'wss://relay.f7z.io,wss://nos.lol,wss://relay.nostr.info,wss://nostr-pub.wellorder.net,wss://relay.current.fyi,wss://relay.nostr.band'
}

relays = relays.split(',');
chatTags = chatTags ? chatTags.split(',') : [];
chatReferenceTags = chatReferenceTags ? chatReferenceTags.split(',') : [];

const embed = new Widget({
	target: div,
	props: {
		websiteOwnerPubkey,
		chatType,
		chatTags,
		chatReferenceTags,
		relays,
		includeTagsInMessage,
		includeUrlInMessage,
	},
});
