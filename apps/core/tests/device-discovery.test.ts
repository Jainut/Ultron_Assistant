import assert from "node:assert/strict";
import test from "node:test";

import {
    parseArpTable,
    parseMdnsResponse,
    parseSsdpResponse,
} from "../src/automation/device-discovery.ts";

test("interpreta aparelhos encontrados na tabela ARP do Windows", () => {
    const entries = parseArpTable(`
Interface: 192.168.0.9 --- 0xd
  192.168.0.7           bc-35-1e-9a-d6-b1     dinâmico
  192.168.0.255         ff-ff-ff-ff-ff-ff     estático
  239.255.255.250       01-00-5e-7f-ff-fa     estático
`);

    assert.deepEqual(
        [...entries],
        [["192.168.0.7", "BC:35:1E:9A:D6:B1"]],
    );
});

test("interpreta anúncios SSDP sem depender da rede", () => {
    const result = parseSsdpResponse(
        [
            "HTTP/1.1 200 OK",
            "LOCATION: http://192.168.0.20:8060/device.xml",
            "SERVER: Roku/14 UPnP/1.0",
            "USN: uuid:roku:ecp:123",
            "",
            "",
        ].join("\r\n"),
        "192.168.0.20",
    );

    assert.equal(result?.headers.location, "http://192.168.0.20:8060/device.xml");
    assert.equal(result?.headers.server, "Roku/14 UPnP/1.0");
});

test("ignora pacotes mDNS inválidos sem interromper o scan", () => {
    assert.deepEqual(parseMdnsResponse(Buffer.alloc(0)), []);
});
