<script>
	import 'websocket-polyfill';
	import Container from '../Container.svelte';
	import Widget from '../Widget.svelte';
	import { chatAdapter } from '../lib/store';

	let chatStarted;
	let chatType = 'GROUP';
	let websiteOwnerPubkey = 'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52';
	let chatTags = [];
	let chatId = '9cef2eead5d91df42eba09be363f1272107e911685126ea5e261ac2d93299478';
	let chatReferenceTags = [];
	const relays = [
		'wss://relay.f7z.io',
		'wss://nos.lol',
		'wss://relay.nostr.band',
	];

	$: currentTopic = [...chatTags, ...chatReferenceTags][0]

	function currentTopic(topic) {
		return [...chatTags, ...chatReferenceTags].includes(topic)
	}
</script>

<svelte:head>
	<title>Nostri.chat / A NOSTR chat widget you control</title>
	<meta property="og:url" content="https://nostri.chat/">
	<meta name="description" content="A chat widget you own, powered by nostr" />
    <meta property="og:description" content="A chat widget you own, powered by nostr" />
</svelte:head>

<section class="
	lg:min-h-screen
	text-white
	bg-gradient-to-b from-orange-500 to-orange-800
">
	<div class="lg:min-h-screen mx-auto w-full lg:max-w-7xl py-5 xl:py-10
		flex flex-col md:flex-row
		gap-20 items-center px-4 lg:px-0
		relative
	">
		<div class="
			md:w-7/12 gap-10
		">
			<section id="hero" style="min-height: 50vh;">
				<h1 class="
					text-6xl
					font-black
					my-2
				">Nostri.chat</h1>

				<h2 class="
					text-2xl lg:text-4xl
					text-bold
				">A chat widget for your site, powered by nostr</h2>

				<p class="
					max-w-prose
					text-2xl
					text-gray-200
					tracking-wide
					leading-9
					my-5
				">
					Simple, interoperable
					communication with your visitors, in a way
					that gives you and them complete ownership
					over the data.
				</p>
			</section>
		</div>

		<div class="flex-row items-center justify-center min-h-screen hidden md:flex md:w-5/12">
			<div class="shadow-2xl bg-gray-100/90 backdrop-blur-md mb-5 w-96 max-w-screen-sm text-black rounded-md p-0 overflow-auto flex flex-col justify-end fixed" style="{chatStarted ? 'max-height: 70vh;' : ''}">
				<Container chatConfiguration={{
					chatType,
					chatId,
					chatTags,
					chatReferenceTags,
				}} {relays} bind:chatStarted={chatStarted} />
			</div>
		</div>
	</div>
</section>

<section class="
	min-h-screen
	py-5
	lg:py-16
" style="min-height: 50vh;">
	<div class="mx-auto w-full lg:max-w-7xl py-5 xl:py-10
	flex flex-col lg:flex-row
	gap-20 px-4 lg:px-0
	" style="min-height: 50vh;">
	<div class="md:w-7/12 flex flex-col gap-8">
		<div>
			<h1 class="text-6xl lg:text-7xl font-black">
				Innovative modes
			</h1>

			<p class="
				text-2xl font-extralight
			">
				Because we use Nostr for communicating,
				<b>Nostri.chat</b>
				can use some new, creative approaches to using chat widget,
				depending on what you want to achieve.
			</p>
		</div>

		<div class="flex flex-col gap-3">
			<h2 class="text-3xl text-orange-600 font-black">
				Classic mode
				<span class="text-2xl text-slate-500 font-extralight block">encrypted 1-on-1 chats</span>
			</h2>

			<p class="
				text-xl text-gray-500 text-justify
				font-light
				leading-8
			">
				Lorem ipsum dolor sit, amet consectetur adipisicing elit. Sapiente quae eveniet placeat, obcaecati nesciunt nam iure. Culpa omnis hic eaque illum alias iure autem atque? Distinctio facilis recusandae omnis expedita.
			</p>

			{#if $chatAdapter}
				{#if chatType === 'DM'}
					<button class="px-4 rounded border-2 border-orange-700 py-2 text-orange-700 text-lg w-full font-semibold">
						Active
					</button>
				{:else}
					<button class="px-4 rounded bg-orange-700 py-2 text-white text-lg w-full font-semibold" on:click={()=>{ chatType='DM'; chatTags=[]; chatReferenceTags=[] }}>
						Try it
					</button>
				{/if}
			{/if}
		</div>

		<div class="flex flex-col gap-3">
			<h2 class="text-3xl text-orange-600 font-black">
				<div class="flex flex-row gap-2">
					<span>🫂</span>
					<span class="flex flex-col">
						<span>Public chat groups</span>
						<span class="text-2xl text-slate-500 font-extralight block">public groups</span>
					</span>
				</div>
			</h2>

			<p class="
				text-xl text-gray-500 text-justify
				font-light
				leading-8
			">
				Embed NIP-28 public chat groups on your site.
			</p>

			<div class="flex flex-col lg:flex-row justify-between mt-10 gap-10 mb-6">
				<div class="flex flex-col lg:w-1/2 items-center gap-4 border p-4 shadow-md rounded-lg w-fit">
					<h3 class="
						text-black
						text-lg
						font-semibold
					">Group chat</h3>
					<span class="inline-flex rounded-md">
						<button type="button" class="
							inline-flex items-center rounded-l-md border px-4 py-2 text-md font-medium
							{chatType === 'GROUP' && chatId === '9cef2eead5d91df42eba09be363f1272107e911685126ea5e261ac2d93299478' ?
							'text-white bg-orange-700 border-orange-900'
						:
							'border-gray-300 bg-white text-gray-700'}
						:ring-indigo-500"
							on:click={()=>{ chatType='GROUP'; chatTags=[]; chatId='9cef2eead5d91df42eba09be363f1272107e911685126ea5e261ac2d93299478' }}
						>
							#Test
						</button>

						<button type="button" class="
							inline-flex items-center rounded-r-md border px-4 py-2 text-md font-medium
							{chatType === 'GROUP' && chatId === 'a6f436a59fdb5e23c757b1e30478742996c54413df777843e0a731af56a96eea' ?
							'text-white bg-orange-700 border-orange-900'
						:
							'border-gray-300 bg-white text-gray-700'}
						:ring-indigo-500"
							on:click={()=>{ chatType='GROUP'; chatTags=[]; chatId='a6f436a59fdb5e23c757b1e30478742996c54413df777843e0a731af56a96eea' }}
						>
							#NDK
						</button>
					</span>

				</div>
			</div>

			<h2 class="text-3xl text-orange-600 font-black">
				<div class="flex flex-row gap-2">
					<span>🔖</span>
					<span class="flex flex-col">
						<span>Tagged Global Chat</span>
						<span class="text-2xl text-slate-500 font-extralight block">public discussion/support</span>
					</span>
				</div>
			</h2>

			<p class="
				text-xl text-gray-500 text-justify
				font-light
				leading-8
			">
				Imagine having a global chat on your website about a certain topic.
				Anyone can participate, from your website or from any Nostr client.
			</p>


			<div class="flex flex-col lg:flex-row justify-between mt-10 gap-10">
				<div class="flex flex-col items-center gap-4 border p-4 shadow-md rounded-lg w-fit lg:w-full">
					<h3 class="
						text-black
						text-lg
						font-semibold
					">🔖 Topic-based chats</h3>

					<span class="inline-flex rounded-md">
						<button type="button" class="
							inline-flex items-center rounded-l-md border px-4 py-2 text-md font-medium
							{currentTopic === 'nostrica' ?
								'text-white bg-orange-700 border-orange-900'
							:
								'border-gray-300 bg-white text-gray-700'}
						" on:click={()=>{ chatType='GLOBAL'; chatTags=['nostrica']; chatReferenceTags=[] }}>
							#nostrica
						</button>

						<button type="button" class="
							inline-flex items-center rounded-r-md border px-4 py-2 text-md font-medium
							{currentTopic === 'bitcoin' ?
								'text-white bg-orange-700 border-orange-900'
							:
								'border-gray-300 bg-white text-gray-700'}
						" on:click={()=>{ chatType='GLOBAL'; chatTags=['bitcoin']; chatReferenceTags=[] }}>
							#bitcoin
						</button>
					</span>
				</div>

				<div class="flex flex-col items-center gap-4 border p-4 shadow-md rounded-lg w-fit lg:w-full">
					<h3 class="
						text-black
						text-lg
						font-semibold
					">🌎 Website-based chats</h3>
						<span class="inline-flex rounded-md">
							<button type="button" class="
								inline-flex items-center rounded-l-md border px-4 py-2 text-md font-medium
								{currentTopic === 'https://nostri.chat' ?
								'text-white bg-orange-700 border-orange-900'
							:
								'border-gray-300 bg-white text-gray-700'}
							:ring-indigo-500"
								on:click={()=>{ chatType='GLOBAL'; chatTags=[]; chatReferenceTags=['https://nostri.chat'] }}
							>
								<span class="opacity-50 font-normal">https://</span>nostri.chat
							</button>
							<button type="button" class="
								inline-flex items-center rounded-r-md border px-4 py-2 text-md font-medium
								{currentTopic === 'https://psbt.io' ?
								'text-white bg-orange-700 border-orange-900'
							:
								'border-gray-300 bg-white text-gray-700'}
							:ring-indigo-500"
								on:click={()=>{ chatType='GLOBAL'; chatTags=[]; chatReferenceTags=['https://psbt.io'] }}
							>
								<span class="opacity-50 font-normal">https://</span>psbt.io
							</button>
					</span>

				</div>
			</div>
		</div>
	</div>
</section>

<section class="
	min-h-screen
	py-5
	lg:py-16
	bg-slate-100
" style="min-height: 50vh;">
	<div class="mx-auto w-full lg:max-w-7xl py-5 xl:py-10
	flex flex-col lg:flex-row
	gap-20 items-center px-4 lg:px-0
	" style="min-height: 50vh;">
		<div class="md:w-4/5 lg:w-3/5 grid grid-cols-1 gap-8">

			<div>
				<h1 class="text-7xl font-black">
					Easy-peasy setup
				</h1>

				<p class="
					text-2xl font-extralight
				">
					Just drop this snippet on your website and you're good to go.
				</p>
			</div>

			<div class="text-xl font-semibold">Public group chat (GROUP)</div>
			<pre class ="
				p-4
				bg-white
				overflow-auto
			">
&lt;script
	src="https://nostri.chat/public/bundle.js"
	<b>data-chat-type</b>="<span class="text-orange-500">GROUP</span>"
	<b>data-chat-id</b>="<span class="text-orange-500">&lt;GROUP_ID_IN_HEX_FORMAT&gt;</span>"
	<b>data-relays</b>="<span class="text-orange-500">wss://relay.f7z.io,wss://nos.lol,wss://relay.nostr.band</span>"
&gt;&lt;/script&gt;
&lt;link rel="stylesheet" href="https://nostri.chat/public/bundle.css"&gt;</pre>

<div class="text-xl font-semibold">Public global notes (kind-1 short notes)</div>
<pre class ="
	p-4
	bg-white
	overflow-auto
">
&lt;script
src="https://nostri.chat/public/bundle.js"
<b>data-chat-type</b>="<span class="text-orange-500">GLOBAL</span>"
<b>data-chat-tags</b>="<span class="text-orange-500">bitcoin</span>"
<b>data-relays</b>="<span class="text-orange-500">wss://relay.f7z.io,wss://nos.lol,wss://relay.nostr.band</span>"
&gt;&lt;/script&gt;
&lt;link rel="stylesheet" href="https://nostri.chat/public/bundle.css"&gt;</pre>

<div class="text-xl font-semibold">Encrypted DMs</div>
			<pre class ="
				p-4
				bg-white
				overflow-auto
			">
&lt;script
src="https://nostri.chat/public/bundle.js"
<b>data-chat-type</b>="<span class="text-orange-500">DM</span>"
<b>data-website-owner-pubkey</b>="<span class="text-orange-500">YOUR_PUBKEY_IN_HEX_FORMAT</span>"
<b>data-relays</b>="<span class="text-orange-500">wss://relay.f7z.io,wss://nos.lol,wss://relay.nostr.band</span>"
&gt;&lt;/script&gt;
&lt;link rel="stylesheet" href="https://nostri.chat/public/bundle.css"&gt;</pre>
		</div>
	</div>
</section>

<div class="md:hidden">
	<Widget chatConfiguration={{
		chatTags,
		chatReferenceTags,
	}} {websiteOwnerPubkey} {chatType} {chatId} {relays} bind:chatStarted={chatStarted} />
</div>

<footer class="py-6 bg-orange-900 font-mono text-white text-center mt-12 px-10">
	<div class="flex justify-center flex-row">
		<div class="text-sm">
			NOSTRI.CHAT
			by
			<a class="text-purple-50 hover:text-orange-400" href="https://pablof7z.com">
				@pablof7z
			</a>
		</div>
	</div>
</footer>

<style>
	/* div { border: solid red 1px; } */

	@tailwind base;
	@tailwind components;
	@tailwind utilities;
</style>