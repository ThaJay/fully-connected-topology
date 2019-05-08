import {connect as _connect, createServer} from 'net'
import {EventEmitter} from 'events'
import {read, write} from 'length-prefixed-message'
import networkAddress from 'network-address'


export default class Topology extends EventEmitter {
  me     = ''
  peers  = {}
  server = null

  constructor (me, peers) {
    super()

    this.me = me
    if (!(this instanceof Topology)) return new Topology(me, peers)
    if (/^\d+$/.test(me)) me = networkAddress() + ':' + me
    if (this.me) this.listen(Number(me.split(':')[1]))

    EventEmitter.call(this)

    if (peers) for (let peer of Object.values(peers)) this.add(peer)
  }

  peer (addr) {
    return (this.peers[addr] && this.peers[addr].socket) || null
  }

  listen (port) {
    this.server = createServer(socket => {this.onconnection(socket)})
    this.server.listen(port)
  }

  add (addr) {
    if (addr === this.me) return

    var host = addr.split(':')[0]
    var port = Number(addr.split(':')[1])
    var peer = this.peers[addr] = this.peers[addr] || {id:addr}

    peer.host = host
    peer.port = port
    peer.retries = 0
    peer.reconnectTimeout = peer.reconnectTimeout || null
    peer.pendingSocket = peer.pendingSocket || null
    peer.socket = peer.socket || null

    this.connect(peer)
  }

  remove (addr) {
    if (addr === this.me) return

    var peer = this.peers[addr]

    if (!peer) return

    delete this.peers[addr]
    peer.host = null // will stop reconnects

    if (peer.socket) peer.socket.destroy()
    if (peer.pendingSocket) peer.pendingSocket.destroy()

    clearTimeout(peer.reconnectTimeout)
  }

  destroy () {
    if (this.server) this.server.close()
    Object.keys(this.peers).forEach(this.remove.bind(this))
  }

  get connections () {
    var peers = this.peers

    return Object.keys(peers).map(id => {return peers[id].socket}).filter(socket => socket)
  }

  onconnection (socket) {
    this.errorHandle(socket)
    read(socket, from => {
      from = from.toString()

      var peer = this.peers[from] = this.peers[from] || {id:from}
      if (from > this.me) return this.connect(peer, socket)

      write(socket, this.me)
      this.attachCleanup(peer, socket)
      this.onready(peer, socket)
    })
  };

  attachCleanup (peer, socket) {
    socket.on('close', function () {
      if (peer.socket === socket) peer.socket = null
      if (peer.pendingSocket === socket) peer.pendingSocket = null
      if (peer.socket) return

      if (!peer.host) return delete this.peers[peer.id]

      peer.retries++
      peer.reconnectTimeout = setTimeout(() => {connect(peer)}, (1 << peer.retries) * 250)
      this.emit('reconnect', peer.id, peer.retries)
    })
  };

  errorHandle (socket) {
    socket.on('error', () => {socket.destroy()})

    // 15s to do the handshake
    socket.setTimeout(15000, () => {socket.destroy()})
  };

  onready (peer, socket) {
    socket.setTimeout(0) // reset timeout
    var oldSocket = peer.socket
    peer.retries = 0
    peer.socket = socket
    peer.pendingSocket = null
    if (oldSocket) oldSocket.destroy()
    this.emit('connection', peer.socket, peer.id)
  };

  connect (peer, socket) {
    if (peer.socket || peer.pendingSocket) return socket && socket.destroy()
    if (peer.reconnectTimeout) clearTimeout(peer.reconnectTimeout)

    if (!socket) socket = _connect(peer.port, peer.host)
    write(socket, this.me)
    peer.pendingSocket = socket

    if (this.me > peer.id) return this.onconnection(socket)

    this.errorHandle(socket)
    this.attachCleanup(peer, socket)

    read(socket, () => {this.onready(peer, socket)})
  };
}
