import socket, time
s = socket.create_connection(("127.0.0.1", 7100), timeout=5)
time.sleep(0.5)
s.recv(4096)
s.sendall(b"screendump /tmp/s.ppm\n")
time.sleep(2)
print(s.recv(4096).decode(errors="replace"))
s.close()
