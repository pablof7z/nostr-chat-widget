<script>
    import { chatAdapter } from './lib/store';
    import KeyPrompt from './KeyPrompt.svelte';
    import ConnectedWidget from './ConnectedWidget.svelte';

    export let websiteOwnerPubkey;
    export let chatStarted;
    export let chatConfiguration;
    export let relays;

    $: chatStarted = !!$chatAdapter
</script>

{#if !chatStarted}
    <KeyPrompt {websiteOwnerPubkey} {chatConfiguration} {relays} />
{:else}
    <ConnectedWidget {websiteOwnerPubkey} {chatConfiguration} {relays} />
{/if}

<style>
	@tailwind base;
	@tailwind components;
	@tailwind utilities;
</style>