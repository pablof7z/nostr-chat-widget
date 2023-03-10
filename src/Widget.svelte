<script>
    import Container from './Container.svelte';

    export let websiteOwnerPubkey;
    export let chatType;
    export let includeTagsInMessage;
    export let includeUrlInMessage;
    export let chatTags;
    export let chatReferenceTags;
    export let relays;

    let showChat = false;
    let dismissedIntro = true;
    let minimizeChat = false;

    function toggleChat() {
        if (showChat) {
            minimizeChat = !minimizeChat;
        } else {
            showChat = !showChat;
        }
    }

    function dismissIntro() {
        dismissedIntro = true;
    }
</script>

<div class="fixed bottom-5 right-5 mb-5 flex flex-col item-end font-sans">
    {#if showChat}
        <div class="
			shadow-2xl
            bg-white mb-5 w-96 max-w-screen-sm text-black rounded-xl p-5 overflow-scroll
            {minimizeChat ? 'hidden' : ''}
        " style="max-height: 80vh;">
            {#if !dismissedIntro}
                <h1 class="
					font-bold
					text-2xl
					text-purple-700">
                    NostriChat
                </h1>

                <p class="text-gray-700 mb-3">
                    This is a FOSS chat app built on top of the Nostr protocol.
                </p>

                <p class="text-gray-700 mb-3">
                    Choose how you would like to chat:
                </p>

                <p class="text-gray-700 mb-3">
                    You can use it to ask for help
                    <span class="font-bold">PSBT.io</span>
                    to the creators of this site or to
                    anyone willing to help.
                </p>

                <p class="text-gray-700 mb-3">
                    Keep in mind that this chat is public,
                    anyone can read it, so don't exchange
                    private information and use common-sense.
                </p>

                <button class="
                    bg-purple-900
                    hover:bg-purple-700
                    w-full
                    p-2
                    py-4
                    text-xl
                    mt-3
                    rounded-xl
                    text-center
                    font-semibold
                    tracking-wide
                    uppercase
                    text-white
                " on:click={dismissIntro}>
                    Continue
                </button>
            {:else}
                <Container
                    {websiteOwnerPubkey}
                    chatConfiguration={{
                        chatType,
                        chatTags,
                        chatReferenceTags,
                        includeTagsInMessage,
                        includeUrlInMessage,
                    }}
                    {relays}
                />
            {/if}
        </div>
    {/if}


    <div class="self-end">
        <a href="#" class="text-white bg-purple-900 hover:bg-purple-700 w-full p-5 rounded-full flex-shrink-1 text-center font-semibold flex flex-row items-center gap-4" on:click|preventDefault={toggleChat}>
            <span class="tracking-wider">
                <span class="
					text-white
				">Nostri</span><span class="text-orange-400 text-6xl -mx-1" style="line-height: 1px;">.</span><span class="text-purple-300">Chat</span>
            </span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6 inline-block">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
        </a>
    </div>
</div>

<style>
	@tailwind base;
	@tailwind components;
	@tailwind utilities;
</style>
