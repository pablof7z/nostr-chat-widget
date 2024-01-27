import Widget from './Widget.svelte';

var div = document.createElement('DIV');
var script = document.currentScript;
const websiteOwnerPubkey = script.getAttribute('data-website-owner-pubkey');
const chatType = script.getAttribute('data-chat-type');
let chatTags = script.getAttribute('data-chat-tags');
let chatId = script.getAttribute('data-chat-id');
let chatReferenceTags = script.getAttribute('data-chat-reference-tags');
let relays = script.getAttribute('data-relays');
let startPage = script.getAttribute('data-start-page');
let hideNostrIcon = script.getAttribute('data-hidenostricon');
let simplifyNostrText = script.getAttribute('data-simplifynostrnext');
let accentColor = script.getAttribute('data-accentcolor');

script.parentNode.insertBefore(div, script);

if (!relays) {
	relays = 'wss://relay.f7z.io,wss://nos.lol,wss://relay.nostr.info,wss://nostr-pub.wellorder.net,wss://relay.current.fyi,wss://relay.nostr.band'
}

relays = relays.split(',');
chatTags = chatTags ? chatTags.split(',') : [];
chatReferenceTags = chatReferenceTags ? chatReferenceTags.split(',') : [];
accentColor = accentColor ? accentColor.split(',') : [];

const embed = new Widget({
	target: div,
	props: {
		accentColor,
		hideNostrIcon,
		simplifyNostrText,
		startPage,
		websiteOwnerPubkey,
		chatType,
		chatTags,
		chatId,
		chatReferenceTags,
		relays
	},
});
