<script>
    import { chatAdapter, chatData, selectedMessage } from './lib/store';
    import { onMount } from 'svelte';
    import NostrNote from './NostrNote.svelte';
    import * as animateScroll from "svelte-scrollto";

    let events = [];
    let responseEvents = [];
    let responses = {};
    let profiles = {};

    export let websiteOwnerPubkey;
    export let chatConfiguration;
    let prevChatConfiguration;

    $: {
        if (chatConfiguration !== prevChatConfiguration && prevChatConfiguration && $chatAdapter) {
            $chatAdapter.setChatConfiguration(chatConfiguration.chatType, chatConfiguration.chatTags, chatConfiguration.chatReferenceTags);
            events = [];
            responses = {};
            rootNoteId = null;
            localStorage.removeItem('rootNoteId');

            // rootNoteId = localStorage.getItem('rootNoteId');
            // if (rootNoteId) {
            //     $chatAdapter.subscribeToEventAndResponses(rootNoteId);
            // }
        }
        prevChatConfiguration = chatConfiguration;
    }

    function getEventById(eventId) {
        let event = events.find(e => e.id === eventId);
        event = event || responseEvents.find(e => e.id === eventId);
        return event;
    }

    async function sendMessage() {
        const input = document.getElementById('message-input');
        const message = input.value;
        input.value = '';
        let extraParams = { tags: [] };

        // if this is the rootLevel we want to tag the owner of the site's pubkey
        if (!rootNoteId) { extraParams.tagPubKeys = [websiteOwnerPubkey] }

        // if we are responding to an event, we want to tag the event and the pubkey
        if ($selectedMessage) {
            extraParams.tags.push(['e', $selectedMessage]);
            extraParams.tagPubKeys.push(getEventById($selectedMessage).pubkey);
        }

        // if (rootNoteId) {
        //     // mark it as a response to the most recent event
        //     const mostRecentEvent = events[events.length - 1];
        //     // go through all the tags and add them to the new message
        //     if (mostRecentEvent) {
        //         mostRecentEvent.tags.forEach(tag => {
        //             if (tag[0] === 'e') {
        //                 extraParams.tags.push(tag);
        //             }
        //         })
        //         extraParams.tags.push(['e', mostRecentEvent.id]);
        //         extraParams.tags.push(['p', mostRecentEvent.pubkey]);
        //     }
        // }
        
        const noteId = await $chatAdapter.send(message, extraParams);

        if (!rootNoteId) {
            rootNoteId = noteId;
            localStorage.setItem('rootNoteId', rootNoteId);
        }
    }
    
    async function inputKeyDown(event) {
        if (event.key === 'Enter') {
            sendMessage();
            event.preventDefault();
        }
    }

    function messageReceived(message) {
        const messageLastEventTag = message.tags.filter(tag => tag[0] === 'e').pop();
        let isThread;
        
        if (chatConfiguration.chatType === 'GLOBAL') {
            isThread = message.tags.filter(tag => tag[0] === 'e').length >= 1;
        } else {
            const pubkeysTagged = message.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]);
            isThread = new Set(pubkeysTagged).size >= 2;
        }
        
        responses[message.id] = [];

        if (isThread) {
            const lastETag = message.tags.filter(tag => tag[0] === 'e').pop();
            if (lastETag && lastETag[1] && responses[lastETag[1]]) {
                responses[lastETag[1]].push(message);
            }

            responseEvents.push(message);
            responseEvents = responseEvents;
        } else {
            // insert message so that it's chronologically ordered by created_at
            let index = 0;
            while (index < events.length && events[index].created_at < message.created_at) {
                index++;
            }
            events.splice(index, 0, message);
            events = events;
        }

        responses = responses;

        scrollDown()
    }

    function scrollDown() {
        animateScroll.scrollToBottom({
            container: document.getElementById('messages-container'),
            offset: 500,
            duration: 50
        })
    }

    function reactionReceived(reaction) {
        const event = events.find(event => event.id === reaction.id);
        if (!event) { return; }

        event.reactions = event.reactions || [];
        event.reactions.push(reaction);
        events = events;
    }

    let rootNoteId;
    
    onMount(() => {
        $chatAdapter.on('message', messageReceived);

        $chatAdapter.on('connectivity', (e) => {
            connectivityStatus = e;
        })

        $chatAdapter.on('reaction', reactionReceived);
        $chatAdapter.on('deleted', (deletedEvents) => {
            deletedEvents.forEach(deletedEventId => {
                const index = events.findIndex(event => event.id === deletedEventId);
                if (index !== -1) {
                    events[index].deleted = true;
                    events = events;
                }
            })
        });

        $chatAdapter.on('profile', ({pubkey, profile}) => {
            let profiles = $chatData.profiles;
            profiles[pubkey] = profile;

            chatData.set({ profiles, ...$chatData })
        })
    });

    let connectivityStatus = {};
    let connectedRelays = 0;
    let totalRelays = 0;

    $: {
        connectedRelays = Object.values(connectivityStatus).filter(status => status === 'connected').length;
        totalRelays = Object.values(connectivityStatus).length;

        if ($chatAdapter?.pubkey && !profiles[$chatAdapter.pubkey]) {
            $chatAdapter.reqProfile($chatAdapter.pubkey)
        }
    }

    $: profiles = $chatData.profiles;

    function selectParent() {
        // get the last tagged event in the tags array of the current $selectedMessage
        const lastETag = getEventById($selectedMessage).tags.filter(tag => tag[0] === 'e').pop();
        const lastETagId = lastETag && lastETag[1];

        $selectedMessage = lastETagId;

        scrollDown()
    }

    let ownName;
    $: ownName = $chatAdapter?.pubkey ? pubkeyName($chatAdapter.pubkey) : "";
    
    function pubkeyName(pubkey) {
        let name;
        
        if (profiles[$chatAdapter.pubkey]) {
            let self = profiles[$chatAdapter.pubkey];

            // https://xkcd.com/927/
            name = self.display_name ||
                    self.displayName || 
                    self.name ||
                    self.nip05;
            
        }

        if (!name) { name = `[${pubkey.slice(0, 6)}]`; }

        return name;
    }
    
</script>

<div class="
    bg-purple-700 text-white
    -m-5 mb-3
    px-5 py-3
    overflow-clip
    flex flex-row justify-between items-center
">

    <div class="text-lg font-semibold">
        {#if $chatAdapter?.pubkey}
            {ownName}
        {/if}
    </div>

    <span class="text-xs flex flex-col items-end mt-2 text-gray-200 gap-1">
        <div class="flex flex-row gap-1 overflow-clip">
            {#each Array(totalRelays) as _, i}
                <span class="
                    inline-block
                    rounded-full
                    {connectedRelays > i ? 'bg-green-500' : 'bg-gray-300'}
                    w-2 h-2
                "></span>
            {/each}
        </div>

        {connectedRelays}/{totalRelays} relays
    </span>
</div>

{#if $selectedMessage}
    {#if !getEventById($selectedMessage)}
        <h1>Couldn't find event with ID {$selectedMessage}</h1>
    {:else}
    <div class="flex flex-row mb-3">
        <a href='#' on:click|preventDefault={selectParent}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12h-15m0 0l6.75 6.75M4.5 12l6.75-6.75" />
            </svg>
        </a>

        <div class="flex flex-col ml-2">
            <span class="text-lg text-black overflow-hidden whitespace-nowrap text-ellipsis">
                {getEventById($selectedMessage).content}
            </span>
        </div>
    </div>
    {/if}
{/if}

<div id="messages-container" class="overflow-scroll">
    {#if $selectedMessage}
        <NostrNote event={getEventById($selectedMessage)} {responses} {websiteOwnerPubkey} />
    {:else}
        {#each events as event}
            <NostrNote {event} {responses} {websiteOwnerPubkey} />
            {#if event.deleted}
                👆 deleted
            {/if}
        {/each}
    {/if}
</div>


<div class="flex flex-col">
    <div class="
        border-y border-y-slate-200
        -mx-5 my-2 bg-slate-100 text-black text-sm
        px-5 py-2
    ">
        {#if chatConfiguration.chatType === 'DM'}
            <b>Encrypted chat:</b>
            only your chat partner can see these messages.
        {:else}
            <b>Public chat:</b>
            anyone can see these messages.
        {/if}
    </div>

    <div class="flex flex-row gap-2 -mx-1">
        <textarea
            type="text"
            id="message-input"
            class="
                -mb-2
                p-2
                w-full
                resize-none
                rounded-xl
                text-gray-600
                border
            " placeholder="Say hello!"
            rows=1
            on:keydown={inputKeyDown}
        ></textarea>
        <button type="button" class="inline-flex items-center rounded-full border border-transparent bg-purple-700 p-3 text-white shadow-sm hover:bg-purple-600 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2" on:click|preventDefault={sendMessage}>
            <!-- Heroicon name: outline/plus -->
            <svg aria-hidden="true" class="w-6 h-6 rotate-90" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"></path></svg>
        </button>
    </div>
</div>

<style>
	@tailwind base;
	@tailwind components;
	@tailwind utilities;
</style>