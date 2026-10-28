import { Client } from '../client';

/** Health checks. Bunwrite answers these without a project or key. */
export class Health {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /** Check that the API answers. */
    get(): Promise<{ name: string; ping: number; status: string }> {
        return this.client.call('get', new URL(this.client.config.endpoint + '/health'), { accept: 'application/json' });
    }

    /** The API version the server reports. */
    getVersion(): Promise<{ version: string }> {
        return this.client.call('get', new URL(this.client.config.endpoint + '/health/version'), { accept: 'application/json' });
    }
}
