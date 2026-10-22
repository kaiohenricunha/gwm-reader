# FINDINGS-DETAIL — confirmed medium or higher

## A read-only MQTT user can take over the reader's fixed client id and make the broker write a retained offline availability to gwmbrasil/#, bypassing the topic ACL

- **Fingerprint:** `mosquitto/mosquitto.conf:clientid-takeover-will:haval-h6-mqtt/mqtt.js:createPublisher`
- **Severity:** medium

### Trace
1. `mosquitto/acl:13` — entrypoint — user kinestra_bridge (and homeassistant at mosquitto/acl:8): kinestra_bridge (acl:13-14) and homeassistant (acl:8-10) are authenticated read-only users with no write rule on gwmbrasil/#, yet each may send a CONNECT presenting any client id. Reproduced: a direct publish to gwmbrasil/h6/availability by each user is refused Not authorized (artifacts/check-1.txt).
2. `mosquitto/mosquitto.conf:8` — propagation — acl_file / listener settings: allow_anonymous false, password_file and acl_file are set (lines 6-8), but no setting binds the client id to the username, so a CONNECT presenting gwm-reader-h6 from another user is accepted by the broker (observed: broker logs New client connected as gwm-reader-h6 u'homeassistant' / u'kinestra_bridge', artifacts/check-2.txt).
3. `haval-h6-mqtt/mqtt.js:117` — propagation — createPublisher: The reader's client id is the predictable gwm-reader-${vehicleId} with clean: true and protocolVersion 5 (lines 116-120), and a QoS 1 retained offline will on gwmbrasil/<id>/availability (line 122).
4. `haval-h6-mqtt/mqtt.js:124` — propagation — createPublisher event handlers: Only error and reconnect handlers are registered (lines 124-125); nothing re-publishes availability when the connection is re-established after a takeover.
5. `haval-h6-mqtt/reader.js:83` — sink — Reader.start: online is published retained exactly once at start; after a takeover fires the reader's will, gwmbrasil/<id>/availability stays offline (retained) until the process restarts. Reproduced: retained value read offline while the read-only user held the client id and after it disconnected (artifacts/check-1.txt).

### Evidence
- `mosquitto/mosquitto.conf:6`: allow_anonymous false, password_file (line 7) and acl_file (line 8) are the only access controls; there is no use_username_as_clientid line anywhere in the file (lines 1-18), so client-id ownership is not tied to the authenticated username.
- `mosquitto/acl:4`: Only gwm_reader may write gwmbrasil/# (acl:3-5); homeassistant (acl:8-10) and kinestra_bridge (acl:13-14) are read-only, so a retained write to gwmbrasil/h6/availability by either is outside their authority. Confirmed at runtime: direct publish returns Not authorized (artifacts/check-1.txt).
- `haval-h6-mqtt/mqtt.js:122`: will: { topic: t.availability, payload: Buffer.from("offline"), qos: 1, retain: true } on a connection with clientId gwm-reader-${vehicleId} (line 117), clean true, protocolVersion 5 — no will-delay, so the will fires immediately on an abnormal close such as session takeover.
- `haval-h6-mqtt/reader.js:83`: The single retained online publish is in Reader.start(); there is no republish on reconnect, so after a takeover-triggered offline the retained value is not restored until the process restarts.
- `README.md:147`: The owner attaches Home Assistant to gwm-reader_mqtt_internal as homeassistant (README.md:140-148) and kinestra_bridge reads gwmbrasil/+/snapshot through a Mosquitto bridge to this broker (README.md:161-168), so both read-only principals are authenticated peers of mosquitto:1883.
- `mosquitto/mosquitto.conf:4`: Local reproduction with the pinned eclipse-mosquitto:2.1.2-alpine image, the repository mosquitto.conf (only file paths rewritten to tmpfs/read-only mounts) and the repository acl verbatim, plus the real createPublisher() as the reader: homeassistant and kinestra_bridge each connected with clientId gwm-reader-h6 (connack 0), the broker logged session taken over for the reader, and the retained gwmbrasil/h6/availability read back as offline and stayed offline after the attacker disconnected; it returned to online only after an explicit reader re-publish, which the production code does not perform on reconnect (artifacts/check-1.txt, artifacts/check-2.txt).

### Principal and resource
An authenticated read-only MQTT peer (homeassistant or kinestra_bridge) that has no write permission on gwmbrasil/# and wants to write a retained value there and/or disrupt the reader. The affected resource is the retained `gwmbrasil/<id>/availability` and the reader's broker session.

### Input and bounded instructions
- payload: `clientId=gwm-reader-h6 (the reader's deterministic id: gwm-reader-<VEHICLE_ID>)`
- payload: `CONNECT username=homeassistant, cleanStart=true, protocolVersion=5, no will`
- payload: `CONNECT username=kinestra_bridge, cleanStart=true, protocolVersion=5, no will`
1. Start the pinned eclipse-mosquitto:2.1.2-alpine broker with the repository mosquitto.conf (only password_file/acl_file/persistence paths rewritten to tmpfs/read-only mounts) and the repository acl verbatim, in an isolated network namespace.
2. Connect the real reader via createPublisher() as gwm_reader with vehicleId h6 and publish online retained to gwmbrasil/h6/availability.
3. As homeassistant, attempt a direct retained publish of offline to gwmbrasil/h6/availability and observe it is refused Not authorized.
4. As homeassistant, open a CONNECT with clientId gwm-reader-h6 and clean start (no will); wait briefly, then read the retained gwmbrasil/h6/availability as homeassistant.
5. Disconnect the attacker and read the retained value again; repeat the sequence as kinestra_bridge.

### Observed output and the invariant it proves
The direct retained publish was refused (Not authorized), confirming the topic ACL. The CONNECT bearing clientId gwm-reader-h6 was accepted (connack 0) for both homeassistant and kinestra_bridge; the broker logged 'Client gwm-reader-h6 ... disconnected: session taken over' and a new client 'gwm-reader-h6 ... u'homeassistant''/'u'kinestra_bridge''. The retained gwmbrasil/h6/availability read back as 'offline' while the read-only user held the id and remained 'offline' after it disconnected; it returned to 'online' only after an explicit reader re-publish (which the production reader does not perform on reconnect). Evidence: agents/v3-mosquitto/artifacts/check-1.txt (probe), agents/v3-mosquitto/artifacts/check-2.txt (broker log).

The invariant: The topic ACL (mosquitto/acl) grants homeassistant and kinestra_bridge read-only access; neither should be able to cause any write to gwmbrasil/#. The gwmbrasil/<id>/availability signal should reflect only the reader's real connection state, and the reader should re-assert online whenever its broker connection is re-established.

### Conditions and containment
- [authentication_level] The actor is an authenticated MQTT user of the broker (holds the homeassistant or kinestra_bridge password, or has compromised Home Assistant or the kinestra bridge, both authenticated peers of mosquitto:1883).
- [authorization_role] The actor's ACL role is read-only on gwmbrasil/# (no write rule), so the resulting retained write is outside its granted authority.
- [system_configuration] mosquitto/mosquitto.conf does not set use_username_as_clientid (or any client-id-to-username binding), so the broker accepts another user's CONNECT bearing the reader's client id.
- [third_party_dependency] Mosquitto 2.1.2 performs MQTT v5 session takeover on a duplicate client id and publishes the taken-over session's retained will (no will-delay), observed directly with the pinned broker image.

### Remediation and regression case
Bind client-id ownership to the authenticated user at the broker and make the reader self-heal its availability. In mosquitto/mosquitto.conf set use_username_as_clientid true so the broker forces each connection's effective client id to its username; a read-only user can then never present gwm-reader-<VEHICLE_ID>, so it cannot take over the reader's session or trigger its will. Independently, defend in depth in the reader: register a client.on('connect') handler that re-publishes availability online retained on every (re)connection, so a transient drop or takeover does not leave a stale retained offline. Keeping both closes the ACL bypass and the persistence of a false unavailable state.

`mosquitto/mosquitto.conf`:
```
listener 1883
protocol mqtt
allow_anonymous false
use_username_as_clientid true
password_file /mosquitto/secrets/passwd
acl_file /mosquitto/config/acl
```
`haval-h6-mqtt/mqtt.js`:
```
  client.on("error", (err) => log?.warn("mqtt error", { error_class: "mqtt", message: err?.message }));
  client.on("reconnect", () => log?.debug("mqtt reconnecting"));
  // Re-assert availability on every (re)connection so a drop or session
  // takeover does not leave a stale retained offline.
  client.on("connect", () => {
    client.publish(t.availability, "online", { qos: 1, retain: true });
  });
```
