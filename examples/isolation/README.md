# Isolated worker reference check

Run `sh examples/isolation/run.sh` with Docker Engine and Docker Compose v2. The script builds a local image, provisions fresh fixture identities/secrets into separate named volumes, runs the checks, and removes that project's containers/networks/volumes on exit. It does not publish ports or mount the Docker socket. Linux CI runs the same script.

```text
Worker container                         Authority container
  UID 10002                                UID 10001
  own identity + exact grant               authority identity + provider token
  read-only filesystem                     protected configuration volume
  no external network interface            internal provider network
          └── signed request over Unix socket ──┘
                                                   │ authenticated fixture read
                                            Provider container
                                              separate configuration volume
```

The worker has `network_mode: none`, all Linux capabilities dropped, no-new-privileges, a PID limit, and a read-only root filesystem. Its mounted provisioning file contains only its own signer, the expected authority DID, and its grant. It sees one group-accessible Unix-domain invocation socket; it has no administration endpoint, authority/provider configuration volume, or host control socket. The privileged initializer runs once, without networking, to assign file ownership and create the fixtures.

The test proves, in this deployment:

- The worker can read the assigned provider record through the verified invocation path.
- A raw signed request for another resource is denied.
- Authority/provider configuration and the Docker socket cannot be read.
- The image and worker provisioning mounts cannot be modified.
- The worker has no non-loopback network interface and cannot contact the provider directly or connect to an external IP.

The authority calls a simulated credentialed provider on a separate internal network. The provider data and credentials are temporary fixtures; this is not a private GitHub account test. The Unix socket is a local transport for the existing serialized invocation API, not a new capability protocol. The authority in this containment fixture uses memory state and has no grant-administration surface. Persistent-state/restart behavior is tested separately by the resource-server example.

This validates a constrained reference boundary, not arbitrary container security or a complete production deployment. Docker/host administrators, the kernel, image supply chain, authority code, and provider remain trusted. The example does not test container escapes, browser/computer-use isolation, public TLS ingress, or a specific production host. Adding networking, mounts, shared process namespaces, privileged tools, or broader credentials changes the boundary and requires new tests. On macOS, Docker uses its Linux virtualization environment; these checks do not isolate a separately controlled macOS desktop.
