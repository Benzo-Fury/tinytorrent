"""libtorrent's side of a conformance case (the engine inside qBittorrent and Deluge).

    python3 lt_peer.py seed|leech <dir> forced|enabled|disabled [torrent file name]
    python3 lt_peer.py make-hybrid <dir> <tracker url>
"""
import os, sys, time
import libtorrent as lt

mode, root, enc = sys.argv[1], sys.argv[2], sys.argv[3]
torrent_name = sys.argv[4] if len(sys.argv) > 4 else "payload.torrent"

if mode == "make-hybrid":
    # A v1+v2 hybrid torrent of the same data, as qBittorrent makes by default:
    # files aligned to pieces with padding files (BEP 47)
    fs = lt.file_storage()
    lt.add_files(fs, os.path.join(root, "data", "conformance"))
    ct = lt.create_torrent(fs, 256 * 1024)
    ct.add_tracker(enc)
    lt.set_piece_hashes(ct, os.path.join(root, "data"))
    with open(os.path.join(root, "hybrid.torrent"), "wb") as f:
        f.write(lt.bencode(ct.generate()))
    info = lt.torrent_info(os.path.join(root, "hybrid.torrent"))
    pads = sum(1 for i in range(info.files().num_files()) if info.files().file_flags(i) & lt.file_storage.flag_pad_file)
    print("made hybrid v1=%s v2=%s padding files=%d" % (info.info_hashes().v1, info.info_hashes().has_v2(), pads), flush=True)
    sys.exit(0)

policy = {"forced": lt.enc_policy.forced, "enabled": lt.enc_policy.enabled, "disabled": lt.enc_policy.disabled}[enc]
session = lt.session({
    "listen_interfaces": "0.0.0.0:6881",
    "enable_dht": False, "enable_lsd": False, "enable_upnp": False, "enable_natpmp": False,
    "out_enc_policy": policy, "in_enc_policy": policy,
    "allowed_enc_level": lt.enc_level.rc4 if enc == "forced" else lt.enc_level.both,
    "prefer_rc4": enc == "forced",
    "allow_multiple_connections_per_ip": True,
    "announce_to_all_trackers": True,
    "user_agent": "libtorrent-conformance",
})
info = lt.torrent_info(os.path.join(root, torrent_name))
save = os.path.join(root, "data") if mode == "seed" else os.path.join(root, "lt-out-%d" % int(time.time()))
handle = session.add_torrent({"ti": info, "save_path": save})
start = time.time()
while True:
    time.sleep(1)
    s = handle.status()
    print("%s %.1f%% peers=%d down=%.1fMB/s up=%.1fMB/s" % (s.state, s.progress * 100, s.num_peers, s.download_rate / 1e6, s.upload_rate / 1e6), flush=True)
    if mode == "leech" and s.is_seeding:
        print("OK: libtorrent finished in %.1f s" % (time.time() - start), flush=True)
        sys.exit(0)
    if mode == "leech" and time.time() - start > 120:
        print("FAIL: libtorrent timed out", flush=True)
        sys.exit(1)
