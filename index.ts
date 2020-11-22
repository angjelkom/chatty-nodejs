import { GraphQLServer, PubSub } from "graphql-yoga";
import { MongoClient, ObjectId } from "mongodb";
import { createWriteStream } from 'fs'
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const storeUpload = async ({ stream, filename }): Promise<any> => {
  const path = `uploads/${filename}`

  return new Promise((resolve, reject) =>
    stream
      .pipe(createWriteStream(path))
      .on('finish', () => resolve(path))
      .on('error', reject),
  )
}

const processUpload = async upload => {
  if (upload == null) return null;
  const { createReadStream, filename, mimetype, encoding } = await upload
  const stream = createReadStream()
  return storeUpload({ stream, filename });
}

const processFiles = async files => {
  return {
    thumbnail: await processUpload(files.thumbnail),
    file: await processUpload(files.file)
  }
}

const main = async () => {
  const MONGO_URL = "mongodb://localhost:27017";
  const client = await MongoClient.connect(MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  const db = client.db("chaty");
  const Users = db.collection("users");
  const Conversations = db.collection("conversations");
  const Messages = db.collection("messages");

  function getUserId(ctx, object = true) {
    const Authorization = ctx.request.get("Authorization");
    if (Authorization) {
      const token = Authorization.replace("Bearer ", "");
      const { userId } = jwt.verify(token, ctx.secret);
      return (object ? ObjectId(userId) : userId) || Error("Please Login first!");
    }
    throw Error("Please Login first!");
  }

  var count = 0;

  const resolvers = {
    Subscription: {
      data: {
        subscribe: (parent, { id }, { pubsub }) => {
          return pubsub.asyncIterator(id);
        }
      },
    },
    Query: {
      conversations(parent, args, context) {
        const _id = getUserId(context);
        return context.Conversations.find({ users: _id }).toArray();
      },
      users(parent, args, { Users }) {
        return Users.find({}).toArray();
      },
      async messages(parent, { id }, { Conversations, Messages }) {
        const conversation = await Conversations.findOne({ _id: ObjectId(id) });
        if (conversation == null) return { error: 'Conversation Not Found!' }
        return Messages.find({ _id: { $in: conversation.messages } }).toArray();
      },
      async profile(parent, args, context) {
        try {
          const user = await context.Users.findOne({ _id: getUserId(context) });
          return user;
        } catch ({ message }) {
          return { error: message };
        }
      },
      async search(parent, { query }, context) {
        try {
          getUserId(context);

          if (!query) return [];

          let regex = { $regex: query, $options: 'i' };
          return await context.Users.find({ name: regex }).toArray();
        } catch ({ message }) {
          return { error: message };
        }
      },
    },
    Mutation: {
      async signup(
        parent,
        { phoneNumber, password, name },
        { Users, secret }
      ) {
        const hash = await bcrypt.hash(password, 10);

        const data = {
          phoneNumber,
          password: hash,
          name,
          createdAt: Date.now(),
          modifiedAt: Date.now()
        };

        const { ops } = await Users.insertOne(data);
        const [user] = ops;
        return {
          userId: user._id,
          token: jwt.sign({ userId: user._id }, secret)
        };
      },
      async login(parent, { phoneNumber, password }, { Users, secret }) {
        const user = await Users.findOne({ phoneNumber });
        if (!user) {
          return { error: `Can't find User with Phone Number: ${phoneNumber}` };
        }

        const valid = await bcrypt.compare(password, user.password);

        if (!valid) {
          return { error: "Wrong password please try again!" };
        }

        return {
          userId: user._id,
          token: jwt.sign({ userId: user._id }, secret)
        };
      },
      async saveProfile(
        parent,
        data,
        context
      ) {

        if (data.profilePhoto) {
          data.profilePhoto = await processUpload(data.profilePhoto)
        }

        const { ok, value } = await context.Users.findOneAndUpdate({ _id: getUserId(context) }, {
          $set: data
        }, { returnOriginal: false });

        return value;
      },
      async addConversation(parent, { users }, context) {

        try {
          const userId = getUserId(context);
          const { ops } = await context.Conversations.insertOne({
            users: [userId, ...users.map((id: string) => ObjectId(id))],
            messages: [],
            createdAt: Date.now(),
            modifiedAt: Date.now()
          });
          let [conversation] = ops;
          users.forEach(userId => context.pubsub.publish(userId, { data: { conversation, update: false } }));
          return conversation;
        } catch ({ message }) {
          return { error: message };
        }
      },
      async sendMessage(parent, { conversation, content, files }, context) {
        try {
          const sender = getUserId(context);

          if (files) {
            files = await Promise.all(files.map(async (file) => await processFiles(file)))
          }

          const { ops } = await context.Messages.insertOne({
            content,
            sender: sender,
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            files
          });
          let [message] = ops
          await context.Conversations.updateOne(
            { _id: ObjectId(conversation) },
            { $push: { messages: message._id }, $set: { modifiedAt: Date.now() } }
          );
          context.pubsub.publish(conversation, { data: { message, update: false } });
          return message;
        } catch ({ message }) {
          return { error: message };
        }
      },
      async deleteMessage(parent, { id }, context) {
        try {
          const sender = getUserId(context);

          const result = await context.Conversations.findOne({ messages: ObjectId(id), users: sender });

          if (result) {
            const { deletedCount } = await context.Messages.deleteOne({ _id: ObjectId(id) });
            return deletedCount > 0 ? { success: 'Message Deleted' } : { error: 'Failed to Delete Message' };
          }

          return { error: "Failed to Delete Message" };
        } catch ({ message }) {
          return { error: message };
        }
      },

      async deleteConversation(parent, { id }, context) {
        try {
          const sender = getUserId(context);

          const { ok, value } = await context.Conversations.findOneAndUpdate({ _id: ObjectId(id) }, {
            $pull: { users: sender }
          }, { returnOriginal: false });

          if (value.users.length === 0) {
            await context.Messages.delete({ _id: { $in: value.messages } });
            await context.Conversations.deleteOne({ _id: value._id });
          } else {
            value.users.forEach(userId => context.pubsub.publish(userId.toString(), { data: { conversation: value, update: true } }));
          }

          // await context.Conversations.deleteOne({ _id: ObjectId(id), users: [] });

          return ok ? { success: 'Conversation Deleted' } : { error: 'Failed to Delete Conversation' };
        } catch ({ message }) {
          return { error: message };
        }
      },
      async singleUpload(obj, { file }) {
        const { createReadStream, filename, mimetype, encoding } = await file;
      },
    },
    User: {
      conversations(parent, args, { Conversations }) {
        return Conversations.find({ users: parent._id }).toArray();
      }
    },
    Conversation: {
      users(parent, args, { Users }) {
        return Users.find({ _id: { $in: parent.users } }).toArray();
      },
      messages(parent, args, { Messages }) {
        return Messages.find({ _id: { $in: parent.messages } }).toArray();
      },
      lastMessage(parent, args, { Messages }) {
        if (parent.messages.length > 0) {
          let id = parent.messages.pop();
          return Messages.findOne({ _id: id });
        }
        return null;
      }
    },
    Message: {
      sender(parent, args, { Users }) {
        return Users.findOne({ _id: parent.sender });
      },
      isLoggedUser(parent, args, ctx) {
        let _u = getUserId(ctx);
        return parent.sender == _u;
      }
    }
  };

  // const processUpload = async upload => {
  //   const { createReadStream, filename, mimetype, encoding } = await upload
  //   const stream = createReadStream()
  //   const { id, path } = await storeUpload({ stream, filename })
  //   return recordFile({ id, filename, mimetype, encoding, path })
  // }

  // const storeUpload = async ({ stream, filename }): Promise<any> => {
  //   const id = shortid.generate()
  //   const path = `${uploadDir}/${id}-${filename}`

  //   return new Promise((resolve, reject) =>
  //     stream
  //       .pipe(createWriteStream(path))
  //       .on('finish', () => resolve({ id, path }))
  //       .on('error', reject),
  //   )
  // }

  const directiveResolvers = {
    isEmail: (next, user, data, ctx, info) => {
      if (/^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(user.email)) return next();
      throw new Error(`Please Enter Valid Email ${info.email} field`);
    }
  };

  const pubsub = new PubSub();
  const server = new GraphQLServer({
    typeDefs: "./schema.graphql",
    resolvers,
    context: ({ request }) => ({
      request,
      Users,
      Conversations,
      Messages,
      pubsub,
      secret: process.env.npm_package_JWT_SECRET || "ww(gst7)nmJ6W}S"
    }),
    directiveResolvers
  });
  server.express.use("/uploads", express.static("uploads"));
  server.start(() => console.log("Server is running on localhost:4000"));
};

main();
