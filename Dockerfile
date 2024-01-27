FROM node:18.7.0

WORKDIR /app

COPY package.json package.json
COPY yarn.lock yarn.lock

RUN yarn

COPY . .

RUN yarn build

CMD [ "yarn", "preview", "--host" ]