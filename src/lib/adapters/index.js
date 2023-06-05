import { chatData } from '../store';
import { getEventHash, relayInit } from 'nostr-tools';
import RelayPool from 'nostr/lib/relay-pool';
import { createEventDispatcher } from 'svelte';
import EventEmitter from 'events';
import * as uuid from 'uuid';
import debug from 'debug';
import { NDKEvent, zapInvoiceFromEvent } from '@nostr-dev-kit/ndk';

const log = new debug('nostr:adapter');
const profilesLog = new debug('nostr:adapter:profiles');
const writeLog = new debug('nostr:adapter:write');

class NstrAdapter {
    relayStatus = {};
    #pool = null;
    #messages = {};
    #eventEmitter = new EventEmitter();
    #handlers = {}
    tags;
    referenceTags;
    type;
    #websiteOwnerPubkey;
    chatId;
    relayUrls = [];

    #profileRequestQueue = [];
    #requestedProfiles = [];
    #profileRequestTimer;
    #delayedSubscriptions = {};
    #delayedSubscriptionTimeouts = {};

    constructor(clientPubkey, {tags, referenceTags, type='DM', chatId, websiteOwnerPubkey, relays} = {}) {
        this.pubkey = clientPubkey;
        this.#websiteOwnerPubkey = websiteOwnerPubkey;
        this.relayUrls = relays

        if (type) {
            this.setChatConfiguration(type, tags, referenceTags, chatId);
        }
    }

    setChatConfiguration(type, tags, referenceTags, chatId) {
        this.type = type;
        this.tags = tags;
        this.chatId = chatId;
        this.referenceTags = referenceTags;

        // handle connection
        if (this.#pool) { this.#disconnect() }

        let filters = [];

        // handle subscriptions
        // if this is DM type then subscribe to chats with this website owner
        switch (this.type) {
            case 'DM':
                filters.push({
                    kinds: [4],
                    '#p': [this.pubkey, this.#websiteOwnerPubkey],
                    'authors': [this.pubkey, this.#websiteOwnerPubkey]
                });
                break;
            case 'GROUP':
                if (this.chatId) {
                    filters.push({
                        kinds: [41, 42],
                        "#e": [this.chatId],
                        limit: 200,
                    })
                }
            case 'GLOBAL':
                if (this.tags && this.tags.length > 0) {
                    filters.push({kinds: [1], '#t': this.tags, limit: 20});
                }
                if (this.referenceTags && this.referenceTags.length > 0) {
                    filters.push({kinds: [1], '#r': this.referenceTags, limit: 20});
                }

                break;
        }

        if (filters && filters.length > 0) {
            this.#connect()
            this.subscribe(filters, (e) => { this.#emitMessage(e) })
        }
    }

    async getPubKey() {
        return this.pubkey;
    }

    on(event, callback) {
        this.#eventEmitter.on(event, callback);
    }

    /**
     * Send a message to the relay
     * @param {String} message - The message to send
     */
    async send(message, {tagPubKeys, tags} = {}) {
        let event;

        if (!tags) { tags = []}

        if (this.type === 'DM') {
            event = await this.sendKind4(message, {tagPubKeys, tags});
        } else if (this.type === 'GROUP') {
            event = await this.sendKind42(message, {tagPubKeys, tags, chatId: this.chatId});
        } else {
            event = await this.sendKind1(message, {tagPubKeys, tags});
        }

        event.id = getEventHash(event)
        const signedEvent = await this.signEvent(event)

        this.#_publish(signedEvent);

        return event.id;
    }

    async sendKind4(message, {tagPubKeys, tags} = {}) {
        let ciphertext = await this.encrypt(this.#websiteOwnerPubkey, message);
        let event = {
            kind: 4,
            pubkey: this.pubkey,
            created_at: Math.floor(Date.now() / 1000),
            content: ciphertext,
            tags: [
                ['p', this.#websiteOwnerPubkey],
                ...tags
            ],
        }

        return event;
    }

    async sendKind42(message, {tagPubKeys, tags, chatId} = {}) {
        if (!tags) { tags = []; }

        if (this.tags) {
            this.tags.forEach((t) => tags.push(['t', t]));
        }

        // check if there is an e tag
        const reply = !!tags.find((t) => t[0] === 'e');

        if (!reply) {
            tags.push(['e', chatId, "wss://nos.lol", reply ? "reply" : "root"]);
        }

        if (this.referenceTags) {
            this.referenceTags.forEach((t) => tags.push(['r', t]));
        }

        let event = {
            kind: 42,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: message,
            pubkey: this.pubkey,
        }

        if (tagPubKeys) {
            for (let pubkey of tagPubKeys) {
                if (pubkey) {
                    event.tags.push(['p', pubkey]);
                }
            }
        }

        event.id = getEventHash(event)
        this.subscribeToEventAndResponses(event.id);

        return event;
    }

    async sendKind1(message, {tagPubKeys, tags} = {}) {
        if (!tags) { tags = []; }

        if (this.tags) {
            this.tags.forEach((t) => tags.push(['t', t]));
        }

        if (this.referenceTags) {
            this.referenceTags.forEach((t) => tags.push(['r', t]));
        }

        let event = {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: message,
            pubkey: this.pubkey,
        }

        if (tagPubKeys) {
            for (let pubkey of tagPubKeys) {
                if (pubkey) {
                    event.tags.push(['p', pubkey]);
                }
            }
        }

        event.id = getEventHash(event)
        this.subscribeToEventAndResponses(event.id);

        return event;
    }

    async #_publish(event) {
        writeLog('publish', event);
        this.#pool.send([ 'EVENT', event ]);
    }

    async onEvent(event, messageCallback) {
        this.#addProfileRequest(event.pubkey);

        messageCallback(event)
    }

    async delayedSubscribe(filters, family, timeout) {
        this.#delayedSubscriptions[family] = this.#delayedSubscriptions[family] || []
        this.#delayedSubscriptions[family].push(filters);

        if (!this.#delayedSubscriptionTimeouts[family]) {
            this.#delayedSubscriptionTimeouts[family] = setTimeout(() => {
                delete this.#delayedSubscriptionTimeouts[family];

                // if there are more than 10 filters then we need to split them up
                // into multiple subscriptions
                let filters = this.#delayedSubscriptions[family];
                delete this.#delayedSubscriptions[family];

                // split filters into groups of 10
                let groups = [];
                groups = filters.reduce((groups, filter, index) => {
                    if (index % 10 === 0) {
                        groups.push([]);
                    }
                    groups[groups.length - 1].push(filter);
                    return groups;
                }, groups);

                groups.forEach((filters) => {
                    this.subscribe(filters, (e) => { this.#emitMessage(e)});
                });
            }, timeout)
        }
    }

    async subscribe(filters, messageCallback=null) {
        if (!messageCallback) { messageCallback = (e) => { this.#emitMessage(e) } }
        return this.#_subscribe(filters, messageCallback)
    }

    async #_subscribe(filters, messageCallback) {
        const subId = uuid.v4();
        this.#handlers[subId] = messageCallback;
        if (!Array.isArray(filters)) { filters = [filters] }



        this.#pool.subscribe(subId, filters);
        this.#pool.on('event', (relay, recSubId, e) => {
            this.onEvent(e, this.#handlers[recSubId])
        });

        return subId;
    }

    async #emitMessage(event) {
        // has already been emitted
        if (this.#messages[event.id]) {
            return;
        }

        this.#messages[event.id] = true;

        // decrypt
        if (event.kind === 4) {
            event.content = await this.decrypt(this.#websiteOwnerPubkey, event.content);
        }

        let deletedEvents = []
        if (event.kind === 5) {
            deletedEvents = event.tags.filter(tag => tag[0] === 'e').map(tag => tag[1]);
        }

        let zap;
        if (event.kind === 9735) {
            const ndkEvent = new NDKEvent(null, event);
            zap = zapInvoiceFromEvent(ndkEvent);
            console.log(`received a zap invoice: ${zap}`, event);
        }

        switch (event.kind) {
            case 1:
            case 42:
                this.#eventEmitter.emit('message', event); break;
            case 41:
                this.#eventEmitter.emit('channelMetadata', event); break;
            case 4: this.#eventEmitter.emit('message', event); break;
            case 5: this.#eventEmitter.emit('deleted', deletedEvents); break;
            case 7: this.#eventEmitter.emit('reaction', event); break;
            case 9735: this.#eventEmitter.emit('zap', zap); break;
            default:
                // alert('unknown event kind ' + event.kind)
                console.log('unknown event kind', event.kind, event);
        }

    }

    subscribeToEventAndResponses(eventId) {
        this.subscribe([
            {ids: [eventId]},
            {'#e': [eventId]},
        ], (e) => {
            this.#emitMessage(e);
            // this.subscribeToResponses(e)
        })
    }

    subscribeToResponses(event) {
        this.subscribe([
            {'#e': [event.id]},
        ], (e) => {
            this.#emitMessage(e);
            this.subscribeToResponses(e)
        })
    }

    /**
     * Connect to the relay
     */
    #connect() {
        this.relayUrls.forEach((url) => {
            this.relayStatus[url] = 'disconnected';
        });
        this.#eventEmitter.emit('connectivity', this.relayStatus);

        // console.log('connecting to relay', this.relayUrls);
        this.#pool = new RelayPool(this.relayUrls)
        this.#pool.on('open', (relay) => {
            // console.log(`connected to ${relay.url}`, new Date())
            this.relayStatus[relay.url] = 'connected';
            this.#eventEmitter.emit('connectivity', this.relayStatus);
        })

        this.#pool.on('error', (relay, r, e) => {
            this.relayStatus[relay.url] = 'error';
            this.#eventEmitter.emit('connectivity', this.relayStatus);
            console.log('error from relay', relay.url, r, e)
        })

        this.#pool.on('close', (relay, r) => {
            this.relayStatus[relay.url] = 'closed';
            this.#eventEmitter.emit('connectivity', this.relayStatus);
            console.log('error from relay', relay.url, r)
        })

        this.#pool.on('notice', (relay, r) => {
            console.log('notice', relay.url, r)
        })
    }

    #disconnect() {
        this.relayUrls.forEach((url) => {
            this.relayStatus[url] = 'disconnected';
        });
        this.#eventEmitter.emit('connectivity', this.relayStatus);
        this.#pool.close();
        this.#pool = null;
    }

    //
    //
    // Profiles
    //
    //
    reqProfile(pubkey) {
        this.#addProfileRequest(pubkey);
    }

    #addProfileRequest(pubkey, event=null) {
        if (this.#profileRequestQueue.includes(pubkey)) { return; }
        if (this.#requestedProfiles.includes(pubkey)) { return; }
        this.#profileRequestQueue.push(pubkey);
        this.#requestedProfiles.push(pubkey);

        if (!this.#profileRequestTimer) {
            this.#profileRequestTimer = setTimeout(() => {
                this.#profileRequestTimer = null;
                this.#requestProfiles();
            }, 500);
        }
    }

    /**
     * Send request for all queued profiles
     */
    async #requestProfiles() {
        if (this.#profileRequestQueue.length > 0) {
            profilesLog('requesting profiles', this.#profileRequestQueue);

            // send request
            const subId = await this.subscribe({ kinds: [0], authors: this.#profileRequestQueue }, (e) => {
                this.#processReceivedProfile(e);
            });
            profilesLog('subscribed to request', {subId})
            this.#profileRequestQueue = [];

            setTimeout(() => {
                profilesLog('unsubscribing from request', {subId})
                this.#pool.unsubscribe(subId);
            }, 5000);
        }
    }

    #processReceivedProfile(event) {
        profilesLog('received profile', event)
        let profile;
        try {
            profile = JSON.parse(event.content);
        } catch (e) {
            profilesLog('failed to parse profile', event);
            return;
        }
        this.#eventEmitter.emit('profile', {pubkey: event.pubkey, profile});
    }
}

export default NstrAdapter;