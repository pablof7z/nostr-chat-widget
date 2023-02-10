import { chatData } from '../store';
import { getEventHash, relayInit } from 'nostr-tools';
import RelayPool from 'nostr/lib/relay-pool';
import { createEventDispatcher } from 'svelte';
import EventEmitter from 'events';
import * as uuid from 'uuid';
import debug from 'debug';

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
    relayUrls = [];

    #profileRequestQueue = [];
    #requestedProfiles = [];
    #profileRequestTimer;

    constructor(clientPubkey, {tags, referenceTags, type='DM', websiteOwnerPubkey, relays} = {}) {
        this.pubkey = clientPubkey;
        this.#websiteOwnerPubkey = websiteOwnerPubkey;
        this.relayUrls = relays

        if (type) {
            this.setChatConfiguration(type, tags, referenceTags);
        }
    }

    setChatConfiguration(type, tags, referenceTags) {
        log('chatConfiguration', {type, tags, referenceTags});
        this.type = type;
        this.tags = tags;
        this.referenceTags = referenceTags;
        
        // handle connection
        if (this.#pool) { this.#disconnect() }
        this.#connect()

        let filters = [];

        console.log('this.tags', this.tags);
        console.log('this.referenceTags', this.referenceTags);
        
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
            case 'GLOBAL':
                if (this.tags && this.tags.length > 0) {
                    filters.push({kinds: [1], '#t': this.tags, limit: 20});
                }
                if (this.referenceTags && this.referenceTags.length > 0) {
                    filters.push({kinds: [1], '#r': this.referenceTags, limit: 20});
                }
                
                break;
        }

        console.log('filters', filters);

        if (filters && filters.length > 0) {
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
                event.tags.push(['p', pubkey]);
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

        // if we have tags we were filtering for, filter here in case the relay doesn't support filtering
        if (this.tags && this.tags.length > 0) {
            if (!event.tags.find(t => t[0] === 't' && this.tags.includes(t[1]))) {
                console.log(`discarded event not tagged with [${this.tags.join(', ')}], tags: ${event.tags.filter(t => t[0] === 't').map(t => t[1]).join(', ')}`);
                return;
            }
        }

        if (event.kind === 1) {
            if (!event.tags.find(t => t[0] === 'e')) {
                // a top level message that we should subscribe to since responses won't tag the url
                this.subscribe({ kinds: [1], '#e': [event.id] })
            }
        }

        let deletedEvents = []
        if (event.kind === 5) {
            deletedEvents = event.tags.filter(tag => tag[0] === 'e').map(tag => tag[1]);
        }

        switch (event.kind) {
            case 1: this.#eventEmitter.emit('message', event); break;
            case 4: this.#eventEmitter.emit('message', event); break;
            case 5: this.#eventEmitter.emit('deleted', deletedEvents); break;
            case 7: this.#eventEmitter.emit('reaction', event); break;
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