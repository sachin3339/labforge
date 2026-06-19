import socket, ssl, sys
host = "127.0.0.1"
port = int(sys.argv[1])
x224 = bytes.fromhex("030000130ee00000000000010008000b000000")
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
s = socket.create_connection((host, port), timeout=5)
s.settimeout(5)
s.sendall(x224)
data = s.recv(64)
print("x224_reply_len=" + str(len(data)) + " hex=" + data.hex())
try:
    tls = ctx.wrap_socket(s, server_hostname=host, do_handshake_on_connect=True)
    cert = tls.getpeercert(binary_form=True) or b""
    print("TLS_OK cert=" + str(len(cert)))
except Exception as e:
    print("TLS_FAIL " + str(e)[:200])
