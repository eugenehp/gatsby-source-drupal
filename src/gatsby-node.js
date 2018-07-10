const axios = require(`axios`)
const crypto = require(`crypto`)
const _ = require(`lodash`)
const { createRemoteFileNode } = require(`@ehp/gatsby-source-filesystem`)
const { URL } = require(`url`)
const { nodeFromData, normalizeTypeName } = require(`./normalize`)

// Get content digest of node.
const createContentDigest = obj =>
  crypto
    .createHash(`md5`)
    .update(JSON.stringify(obj))
    .digest(`hex`)

exports.sourceNodes = async (
  { actions, getNode, hasNodeChanged, store, cache, createNodeId },
  { baseUrl, apiBase }
) => {
  const { createNode } = actions

  // Default apiBase to `jsonapi`
  apiBase = apiBase || `jsonapi`

  // Touch existing Drupal nodes so Gatsby doesn't garbage collect them.
  // _.values(store.getState().nodes)
  // .filter(n => n.internal.type.slice(0, 8) === `drupal__`)
  // .forEach(n => touchNode({ nodeId: n.id }))

  // Fetch articles.
  // console.time(`fetch Drupal data`)
  console.log(`Starting to fetch data from Drupal`)

  // TODO restore this
  // let lastFetched
  // if (
  // store.getState().status.plugins &&
  // store.getState().status.plugins[`gatsby-source-drupal`]
  // ) {
  // lastFetched = store.getState().status.plugins[`gatsby-source-drupal`].status
  // .lastFetched
  // }

  const data = await axios.get(`${baseUrl}/${apiBase}`)
  const allData = await Promise.all(
    _.map(data.data.links, async (url, type) => {
      if (type === `self`) return
      if (!url) return
      if (!type) return
      const getNext = async (url, data = []) => {
        const d = await axios.get(url)
        data = data.concat(d.data.data)
        if (d.data.links.next) {
          data = await getNext(d.data.links.next, data)
        }

        return data
      }

      const data = await getNext(url)

      const result = {
        type,
        data,
      }

      // eslint-disable-next-line consistent-return
      return result
    })
  )

  // Make list of all IDs so we can check against that when creating
  // relationships.
  const ids = {}
  _.each(allData, contentType => {
    if (!contentType) return
    _.each(contentType.data, datum => {
      ids[datum.id] = true
    })
  })

  // Create back references
  var backRefs = {};

  addBackRef = function addBackRef(sourceId, linkedId, relationshipName, type) {
    if (ids[linkedId]) {
      if (typeof backRefs[linkedId] === `undefined`) {
        backRefs[linkedId] = [];
      }
      backRefs[linkedId].push({
        id: sourceId,
        type: normalizeTypeName(`backref_${relationshipName}`)
      });
      backRefs[linkedId].push({
        id: sourceId,
        type: normalizeTypeName(`backref_${relationshipName}_${type}`)
      });
    }
  };

  _.each(allData, function (contentType) {
    if (!contentType) return;
    _.each(contentType.data, function (datum) {
      if (datum.relationships) {
        _.each(datum.relationships, function (v, k) {
          if (!v.data) {
            return;
          }

          if (_.isArray(v.data)) {
            v.data.forEach(function (data) {
              addBackRef(datum.id, data.id, k, contentType.type);
            });
          } else {
            addBackRef(datum.id, v.data.id, k, contentType.type);
          }
        });
      }
    });
  });

  // Process nodes
  const nodes = []
  _.each(allData, contentType => {
    if (!contentType) return

    _.each(contentType.data, datum => {
      const node = nodeFromData(datum, createNodeId)

      // Add relationships
      if (datum.relationships) {
        var addedRelationships = false;
        node.relationships = {}
        _.each(datum.relationships, (v, k) => {
          if (!v.data) return
          
          if (_.isArray(v.data) && v.data.length > 0) {
            node.relationships[`${normalizeTypeName(k)}___NODE`] = v.data.map(function (data) {
              return data.id;
            });
            addedRelationships = true;
          } else if (ids[v.data.id]) {
            node.relationships[`${normalizeTypeName(k)}___NODE`] = v.data.id;
            addedRelationships = true;
          }
        })

        if (backRefs[datum.id]) {
          backRefs[datum.id].forEach(function (ref) {
            if (!node.relationships[`${ref.type}___NODE`]) {
              node.relationships[`${ref.type}___NODE`] = [];
            }

            node.relationships[`${ref.type}___NODE`].push(ref.id);
            addedRelationships = true;
          });
        }

        if (!addedRelationships) {
          delete node.relationships;
        }
      }
      node.internal.contentDigest = createContentDigest(node)
      nodes.push(node)
    })
  })

  // Download all files.
  await Promise.all(
    nodes.map(async node => {
      let fileNode
      if (
        node.internal.type === `files` ||
        node.internal.type === `file__file`
      ) {
        try {
          // Resolve w/ baseUrl if node.uri isn't absolute.
          const url = new URL(node.url, baseUrl)
          fileNode = await createRemoteFileNode({
            url: url.href,
            store,
            cache,
            createNode,
            createNodeId,
          })
        } catch (e) {
          // Ignore
        }
        if (fileNode) {
          node.localFile___NODE = fileNode.id
        }
      }
    })
  )

  nodes.forEach(n => createNode(n))
}
