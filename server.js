
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Өрөөнүүдийн мэдээлэл
const rooms = new Map();

app.get("/", (req, res) => {
  res.send("BLACKCLUB ONLINE SERVER IS RUNNING");
});

app.get("/api/rooms", (req, res) => {
  const list = [...rooms.values()].map(room => ({
    id: room.id,
    name: room.name,
    game: room.game,
    players: room.players.length,
    maxPlayers: room.maxPlayers
  }));

  res.json(list);
});

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    game: room.game,
    maxPlayers: room.maxPlayers,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      chips: player.chips,
      ready: player.ready
    }))
  };
}

function sendRoom(room) {
  io.to(room.id).emit("room:update", publicRoom(room));
}

function removePlayer(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(
    player => player.id !== socket.id
  );

  socket.leave(roomId);
  socket.data.roomId = null;

  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    sendRoom(room);
  }
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.emit("server:message", {
    message: "WELCOME TO BLACKCLUB"
  });

  // Өрөө үүсгэх
  socket.on("room:create", (data, callback) => {
    if (socket.data.roomId) {
      return callback?.({
        success: false,
        message: "Та аль хэдийн өрөөнд байна."
      });
    }

    const game = data?.game;

    if (!["texas", "omaha"].includes(game)) {
      return callback?.({
        success: false,
        message: "Тоглоомын төрөл буруу байна."
      });
    }

    const room = {
      id: createRoomId(),
      name: data.name || "BLACKCLUB ROOM",
      game,
      maxPlayers: 6,
      players: [],
      status: "waiting",
      createdAt: Date.now()
    };

    rooms.set(room.id, room);

    joinRoom(socket, room, data.playerName, callback);
  });

  // Өрөөнд нэгдэх
  socket.on("room:join", (data, callback) => {
    if (socket.data.roomId) {
      return callback?.({
        success: false,
        message: "Та эхлээд одоогийн өрөөнөөс гарах хэрэгтэй."
      });
    }

    const room = rooms.get(
      String(data?.roomId || "").toUpperCase()
    );

    if (!room) {
      return callback?.({
        success: false,
        message: "Өрөө олдсонгүй."
      });
    }

    if (room.players.length >= room.maxPlayers) {
      return callback?.({
        success: false,
        message: "Өрөө дүүрсэн байна."
      });
    }

    if (room.status !== "waiting") {
      return callback?.({
        success: false,
        message: "Тоглолт эхэлсэн байна."
      });
    }

    joinRoom(socket, room, data.playerName, callback);
  });

  // Өрөөнд тоглогч нэмэх
  function joinRoom(socket, room, playerName, callback) {
    const player = {
      id: socket.id,
      name: String(playerName || "Player").slice(0, 20),
      chips: 10000,
      ready: false
    };

    room.players.push(player);

    socket.join(room.id);
    socket.data.roomId = room.id;

    sendRoom(room);

    callback?.({
      success: true,
      room: publicRoom(room)
    });
  }

  // Өрөөнөөс гарах
  socket.on("room:leave", () => {
    removePlayer(socket);
  });

  // Тоглогч бэлэн болох
  socket.on("player:ready", (callback) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;

    const player = room.players.find(
      p => p.id === socket.id
    );

    if (!player) return;

    player.ready = true;
    sendRoom(room);

    callback?.({ success: true });
  });

  // Өрөөний мэдээлэл хүсэх
  socket.on("room:get", (callback) => {
    const room = rooms.get(socket.data.roomId);

    callback?.(
      room
        ? { success: true, room: publicRoom(room) }
        : { success: false, message: "Өрөөнд ороогүй байна." }
    );
  });

  socket.on("disconnect", () => {
    removePlayer(socket);
    console.log("Disconnected:", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BLACKCLUB server running on port ${PORT}`);
});

