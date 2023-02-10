import NstrAdapter from './index.js';
import { Connect } from '@nostr-connect/connect';

class NstrAdapterNip46 extends NstrAdapter {
    #secretKey = null;
    
    constructor(pubkey, secretKey, adapterConfig = {}) {
        super(pubkey, adapterConfig);
        this.#secretKey = secretKey;
    }

    async signEvent(event) {
        const connect = new Connect({
            secretKey: this.#secretKey,
            target: this.pubkey,
        });
        await connect.init();
        
        event.sig = await connect.signEvent('12323423434');
        return event;
    }
}

export default NstrAdapterNip46;
