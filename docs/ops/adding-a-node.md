# Adding a new lab node

LabForge now schedules lab containers across one or more **nodes**.
The control-plane talks to each remote Docker daemon over SSH; no extra
TCP ports need to be opened on the new box.

## 1. Provision the box

Any modern Linux host with Docker installed will do. Confirmed working:

- Ubuntu 22.04 LTS, Docker 24+
- 4+ vCPU / 8+ GiB RAM (more is better — labs are CPU-bound)
- A static IP or hostname reachable by the control-plane

```bash
# On the new node:
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker ubuntu     # so we don't need sudo over SSH
sudo systemctl enable --now docker
```

Pre-pull the lab images you intend to run (otherwise the first provision
on this node will block while the image downloads):

```bash
sudo docker pull labforge/ubuntu-trainer:1.1
sudo docker pull kasmweb/kali-rolling-desktop:1.16.0
# ...
```

Create the `labforge_labnet` bridge network the control plane expects:

```bash
sudo docker network create labforge_labnet || true
```

## 2. Grant the control-plane SSH access

On the control-plane host, generate a dedicated keypair (skip if you
already have one):

```bash
sudo mkdir -p /etc/labforge/keys
sudo ssh-keygen -t ed25519 -N '' -f /etc/labforge/keys/nodes
```

Append the **public** half to the new node's `~/.ssh/authorized_keys`:

```bash
ssh ubuntu@<NEW-NODE-IP> 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys' \
    < /etc/labforge/keys/nodes.pub
```

Sanity-check it:

```bash
sudo ssh -i /etc/labforge/keys/nodes ubuntu@<NEW-NODE-IP> 'docker version --format "{{.Server.Version}}"'
```

## 3. Register the node in the admin UI

In **Platform → Nodes → Add a node**:

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| Name           | e.g. `box-2` (lowercase, no spaces)      |
| Connection     | `ssh`                                    |
| SSH host       | The new node's reachable IP/hostname     |
| SSH user       | `ubuntu` (or whoever is in the docker group) |
| SSH port       | `22`                                     |
| SSH key path   | `/etc/labforge/keys/nodes` (path on **control-plane** host) |
| Proxy host     | The address the **control-plane** uses to reach this node's published ports. Same as SSH host if both control-plane and node share a network; otherwise use a Tailscale/VPN IP. |
| Bind IP        | The interface on the **node** that container ports bind to. Set to a private/Tailscale IP to keep labs off the public internet. |
| Capacity hint  | Soft cap shown in the UI (0 = unlimited) |

Click **Add node**, then **Test connection** — you should see
`Ping OK — Docker XX.YY.Z (api 1.43)`.

## 4. Direct traffic at the new node

By default, new instances still land on the default node. Two ways to
route work to the new box:

- **Per-template pin** — open **Templates → ⋯ → Edit** and set
  *Pin to node*. Every future lab from that template runs on the chosen
  node.
- **Per-tenant pin** — `PATCH /api/v1/platform/tenants/:id` with
  `{"defaultNodeId": "<node-id>"}`. Every lab for that tenant runs on
  the pinned node regardless of template.

Resolution order at provision time:
`tenant.defaultNodeId` → `template.defaultNodeId` → `Node.isDefault` →
the sole enabled node (single-host fallback).

## 5. Decommissioning

To take a node out of rotation **without** terminating its live labs,
click **Drain (disable)**. New provisions skip drained nodes; existing
containers keep running and can be suspended/resumed normally.

Once the node is empty (`0 instances` in the table), click
**Delete node**. The API refuses to delete a node with active instances —
terminate or migrate them first.

## Network model recap

```
   [browser]
      │  https://<sub>.lab.example.com
      ▼
[control-plane / proxy]
      │  TCP/TLS (or HTTP) to <node.proxyHost>:<hostPort>
      ▼
  [node]  ──── docker container :6901 published on bindIp:hostPort
                │
                │  SSH tunnel (control-plane → node:22 → /var/run/docker.sock)
                │  used only for lifecycle ops (create/start/stop/inspect/exec)
                ▼
        [docker daemon on the node]
```

The proxy connection is the **only** path lab traffic takes. Make sure
the chosen `proxyHost`/`bindIp` is reachable from the control-plane.
