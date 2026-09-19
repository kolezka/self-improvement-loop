// @bun
var __defProp = Object.defineProperty;
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __exportCjs = (target, getters, setters) => {
  for (var name in getters)
    __defProp(target, name, {
      get: getters[name],
      set: setters[name],
      enumerable: true,
      configurable: true
    });
};
var __require = import.meta.require;

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS(function(exports) {
  var ALIAS = Symbol.for("yaml.alias");
  var DOC = Symbol.for("yaml.document");
  var MAP = Symbol.for("yaml.map");
  var PAIR = Symbol.for("yaml.pair");
  var SCALAR = Symbol.for("yaml.scalar");
  var SEQ = Symbol.for("yaml.seq");
  var NODE_TYPE = Symbol.for("yaml.node.type");
  var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
  var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
  var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
  var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
  var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
  var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
  function isCollection(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case MAP:
        case SEQ:
          return true;
      }
    return false;
  }
  function isNode(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case ALIAS:
        case MAP:
        case SCALAR:
        case SEQ:
          return true;
      }
    return false;
  }
  var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
  exports.ALIAS = ALIAS;
  exports.DOC = DOC;
  exports.MAP = MAP;
  exports.NODE_TYPE = NODE_TYPE;
  exports.PAIR = PAIR;
  exports.SCALAR = SCALAR;
  exports.SEQ = SEQ;
  exports.hasAnchor = hasAnchor;
  exports.isAlias = isAlias;
  exports.isCollection = isCollection;
  exports.isDocument = isDocument;
  exports.isMap = isMap;
  exports.isNode = isNode;
  exports.isPair = isPair;
  exports.isScalar = isScalar;
  exports.isSeq = isSeq;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/visit.js
var require_visit = __commonJS(function(exports) {
  var identity = require_identity();
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove node");
  function visit(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      visit_(null, node, visitor_, Object.freeze([]));
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  function visit_(key, node, visitor, path) {
    const ctrl = callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visit_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = visit_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = visit_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = visit_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  async function visitAsync(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      await visitAsync_(null, node, visitor_, Object.freeze([]));
  }
  visitAsync.BREAK = BREAK;
  visitAsync.SKIP = SKIP;
  visitAsync.REMOVE = REMOVE;
  async function visitAsync_(key, node, visitor, path) {
    const ctrl = await callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visitAsync_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = await visitAsync_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = await visitAsync_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = await visitAsync_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  function initVisitor(visitor) {
    if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
      return Object.assign({
        Alias: visitor.Node,
        Map: visitor.Node,
        Scalar: visitor.Node,
        Seq: visitor.Node
      }, visitor.Value && {
        Map: visitor.Value,
        Scalar: visitor.Value,
        Seq: visitor.Value
      }, visitor.Collection && {
        Map: visitor.Collection,
        Seq: visitor.Collection
      }, visitor);
    }
    return visitor;
  }
  function callVisitor(key, node, visitor, path) {
    if (typeof visitor === "function")
      return visitor(key, node, path);
    if (identity.isMap(node))
      return visitor.Map?.(key, node, path);
    if (identity.isSeq(node))
      return visitor.Seq?.(key, node, path);
    if (identity.isPair(node))
      return visitor.Pair?.(key, node, path);
    if (identity.isScalar(node))
      return visitor.Scalar?.(key, node, path);
    if (identity.isAlias(node))
      return visitor.Alias?.(key, node, path);
    return;
  }
  function replaceNode(key, path, node) {
    const parent = path[path.length - 1];
    if (identity.isCollection(parent)) {
      parent.items[key] = node;
    } else if (identity.isPair(parent)) {
      if (key === "key")
        parent.key = node;
      else
        parent.value = node;
    } else if (identity.isDocument(parent)) {
      parent.contents = node;
    } else {
      const pt = identity.isAlias(parent) ? "alias" : "scalar";
      throw new Error(`Cannot replace node with ${pt} parent`);
    }
  }
  exports.visit = visit;
  exports.visitAsync = visitAsync;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS(function(exports) {
  var identity = require_identity();
  var visit = require_visit();
  var escapeChars = {
    "!": "%21",
    ",": "%2C",
    "[": "%5B",
    "]": "%5D",
    "{": "%7B",
    "}": "%7D"
  };
  var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

  class Directives {
    constructor(yaml, tags) {
      this.docStart = null;
      this.docEnd = false;
      this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
      this.tags = Object.assign({}, Directives.defaultTags, tags);
    }
    clone() {
      const copy = new Directives(this.yaml, this.tags);
      copy.docStart = this.docStart;
      return copy;
    }
    atDocument() {
      const res = new Directives(this.yaml, this.tags);
      switch (this.yaml.version) {
        case "1.1":
          this.atNextDocument = true;
          break;
        case "1.2":
          this.atNextDocument = false;
          this.yaml = {
            explicit: Directives.defaultYaml.explicit,
            version: "1.2"
          };
          this.tags = Object.assign({}, Directives.defaultTags);
          break;
      }
      return res;
    }
    add(line, onError) {
      if (this.atNextDocument) {
        this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
        this.tags = Object.assign({}, Directives.defaultTags);
        this.atNextDocument = false;
      }
      const parts = line.trim().split(/[ \t]+/);
      const name = parts.shift();
      switch (name) {
        case "%TAG": {
          if (parts.length !== 2) {
            onError(0, "%TAG directive should contain exactly two parts");
            if (parts.length < 2)
              return false;
          }
          const [handle, prefix] = parts;
          this.tags[handle] = prefix;
          return true;
        }
        case "%YAML": {
          this.yaml.explicit = true;
          if (parts.length !== 1) {
            onError(0, "%YAML directive should contain exactly one part");
            return false;
          }
          const [version] = parts;
          if (version === "1.1" || version === "1.2") {
            this.yaml.version = version;
            return true;
          } else {
            const isValid = /^\d+\.\d+$/.test(version);
            onError(6, `Unsupported YAML version ${version}`, isValid);
            return false;
          }
        }
        default:
          onError(0, `Unknown directive ${name}`, true);
          return false;
      }
    }
    tagName(source, onError) {
      if (source === "!")
        return "!";
      if (source[0] !== "!") {
        onError(`Not a valid tag: ${source}`);
        return null;
      }
      if (source[1] === "<") {
        const verbatim = source.slice(2, -1);
        if (verbatim === "!" || verbatim === "!!") {
          onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
          return null;
        }
        if (source[source.length - 1] !== ">")
          onError("Verbatim tags must end with a >");
        return verbatim;
      }
      const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
      if (!suffix)
        onError(`The ${source} tag has no suffix`);
      const prefix = this.tags[handle];
      if (prefix) {
        try {
          return prefix + decodeURIComponent(suffix);
        } catch (error) {
          onError(String(error));
          return null;
        }
      }
      if (handle === "!")
        return source;
      onError(`Could not resolve tag: ${source}`);
      return null;
    }
    tagString(tag) {
      for (const [handle, prefix] of Object.entries(this.tags)) {
        if (tag.startsWith(prefix))
          return handle + escapeTagName(tag.substring(prefix.length));
      }
      return tag[0] === "!" ? tag : `!<${tag}>`;
    }
    toString(doc) {
      const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
      const tagEntries = Object.entries(this.tags);
      let tagNames;
      if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
        const tags = {};
        visit.visit(doc.contents, (_key, node) => {
          if (identity.isNode(node) && node.tag)
            tags[node.tag] = true;
        });
        tagNames = Object.keys(tags);
      } else
        tagNames = [];
      for (const [handle, prefix] of tagEntries) {
        if (handle === "!!" && prefix === "tag:yaml.org,2002:")
          continue;
        if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
          lines.push(`%TAG ${handle} ${prefix}`);
      }
      return lines.join(`
`);
    }
  }
  Directives.defaultYaml = { explicit: false, version: "1.2" };
  Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
  exports.Directives = Directives;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS(function(exports) {
  var identity = require_identity();
  var visit = require_visit();
  function anchorIsValid(anchor) {
    if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
      const sa = JSON.stringify(anchor);
      const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
      throw new Error(msg);
    }
    return true;
  }
  function anchorNames(root) {
    const anchors = new Set;
    visit.visit(root, {
      Value(_key, node) {
        if (node.anchor)
          anchors.add(node.anchor);
      }
    });
    return anchors;
  }
  function findNewAnchor(prefix, exclude) {
    for (let i = 1;; ++i) {
      const name = `${prefix}${i}`;
      if (!exclude.has(name))
        return name;
    }
  }
  function createNodeAnchors(doc, prefix) {
    const aliasObjects = [];
    const sourceObjects = new Map;
    let prevAnchors = null;
    return {
      onAnchor: (source) => {
        aliasObjects.push(source);
        prevAnchors ?? (prevAnchors = anchorNames(doc));
        const anchor = findNewAnchor(prefix, prevAnchors);
        prevAnchors.add(anchor);
        return anchor;
      },
      setAnchors: () => {
        for (const source of aliasObjects) {
          const ref = sourceObjects.get(source);
          if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
            ref.node.anchor = ref.anchor;
          } else {
            const error = new Error("Failed to resolve repeated object (this should not happen)");
            error.source = source;
            throw error;
          }
        }
      },
      sourceObjects
    };
  }
  exports.anchorIsValid = anchorIsValid;
  exports.anchorNames = anchorNames;
  exports.createNodeAnchors = createNodeAnchors;
  exports.findNewAnchor = findNewAnchor;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS(function(exports) {
  function applyReviver(reviver, obj, key, val) {
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (let i = 0, len = val.length;i < len; ++i) {
          const v0 = val[i];
          const v1 = applyReviver(reviver, val, String(i), v0);
          if (v1 === undefined)
            delete val[i];
          else if (v1 !== v0)
            val[i] = v1;
        }
      } else if (val instanceof Map) {
        for (const k of Array.from(val.keys())) {
          const v0 = val.get(k);
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            val.delete(k);
          else if (v1 !== v0)
            val.set(k, v1);
        }
      } else if (val instanceof Set) {
        for (const v0 of Array.from(val)) {
          const v1 = applyReviver(reviver, val, v0, v0);
          if (v1 === undefined)
            val.delete(v0);
          else if (v1 !== v0) {
            val.delete(v0);
            val.add(v1);
          }
        }
      } else {
        for (const [k, v0] of Object.entries(val)) {
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            delete val[k];
          else if (v1 !== v0)
            val[k] = v1;
        }
      }
    }
    return reviver.call(obj, key, val);
  }
  exports.applyReviver = applyReviver;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS(function(exports) {
  var identity = require_identity();
  function toJS(value, arg, ctx) {
    if (Array.isArray(value))
      return value.map((v, i) => toJS(v, String(i), ctx));
    if (value && typeof value.toJSON === "function") {
      if (!ctx || !identity.hasAnchor(value))
        return value.toJSON(arg, ctx);
      const data = { aliasCount: 0, count: 1, res: undefined };
      ctx.anchors.set(value, data);
      ctx.onCreate = (res) => {
        data.res = res;
        delete ctx.onCreate;
      };
      const res = value.toJSON(arg, ctx);
      if (ctx.onCreate)
        ctx.onCreate(res);
      return res;
    }
    if (typeof value === "bigint" && !ctx?.keep)
      return Number(value);
    return value;
  }
  exports.toJS = toJS;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS(function(exports) {
  var applyReviver = require_applyReviver();
  var identity = require_identity();
  var toJS = require_toJS();

  class NodeBase {
    constructor(type) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: type });
    }
    clone() {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      if (!identity.isDocument(doc))
        throw new TypeError("A document argument is required");
      const ctx = {
        anchors: new Map,
        doc,
        keep: true,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this, "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res } of ctx.anchors.values())
          onAnchor(res, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
  }
  exports.NodeBase = NodeBase;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS(function(exports) {
  var anchors = require_anchors();
  var visit = require_visit();
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();

  class Alias extends Node.NodeBase {
    constructor(source) {
      super(identity.ALIAS);
      this.source = source;
      Object.defineProperty(this, "tag", {
        set() {
          throw new Error("Alias nodes cannot have tags");
        }
      });
    }
    resolve(doc, ctx) {
      if (ctx?.maxAliasCount === 0)
        throw new ReferenceError("Alias resolution is disabled");
      let nodes;
      if (ctx?.aliasResolveCache) {
        nodes = ctx.aliasResolveCache;
      } else {
        nodes = [];
        visit.visit(doc, {
          Node: (_key, node) => {
            if (identity.isAlias(node) || identity.hasAnchor(node))
              nodes.push(node);
          }
        });
        if (ctx)
          ctx.aliasResolveCache = nodes;
      }
      let found = undefined;
      for (const node of nodes) {
        if (node === this)
          break;
        if (node.anchor === this.source)
          found = node;
      }
      if (found && ctx) {
        const { anchors, doc, maxAliasCount } = ctx;
        let data = anchors.get(found);
        if (!data) {
          toJS.toJS(found, null, ctx);
          data = anchors.get(found);
        }
        if (data?.res === undefined) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, found, anchors);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
      }
      return found;
    }
    toJSON(_arg, ctx) {
      if (!ctx)
        return { source: this.source };
      const source = this.resolve(ctx.doc, ctx);
      if (!source) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new ReferenceError(msg);
      }
      return ctx.anchors.get(source).res;
    }
    toString(ctx, _onComment, _onChompKeep) {
      const src = `*${this.source}`;
      if (ctx) {
        anchors.anchorIsValid(this.source);
        if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new Error(msg);
        }
        if (ctx.implicitKey)
          return `${src} `;
      }
      return src;
    }
  }
  function getAliasCount(doc, node, anchors) {
    if (identity.isAlias(node)) {
      const source = node.resolve(doc);
      const anchor = anchors && source && anchors.get(source);
      return anchor ? anchor.count * anchor.aliasCount : 0;
    } else if (identity.isCollection(node)) {
      let count = 0;
      for (const item of node.items) {
        const c = getAliasCount(doc, item, anchors);
        if (c > count)
          count = c;
      }
      return count;
    } else if (identity.isPair(node)) {
      const kc = getAliasCount(doc, node.key, anchors);
      const vc = getAliasCount(doc, node.value, anchors);
      return Math.max(kc, vc);
    }
    return 1;
  }
  exports.Alias = Alias;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS(function(exports) {
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();
  var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

  class Scalar extends Node.NodeBase {
    constructor(value) {
      super(identity.SCALAR);
      this.value = value;
    }
    toJSON(arg, ctx) {
      return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
    }
    toString() {
      return String(this.value);
    }
  }
  Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
  Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
  Scalar.PLAIN = "PLAIN";
  Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
  Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
  exports.Scalar = Scalar;
  exports.isScalarValue = isScalarValue;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS(function(exports) {
  var Alias = require_Alias();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var defaultTagPrefix = "tag:yaml.org,2002:";
  function findTagObject(value, tagName, tags) {
    if (tagName) {
      const match = tags.filter((t) => t.tag === tagName);
      const tagObj = match.find((t) => !t.format) ?? match[0];
      if (!tagObj)
        throw new Error(`Tag ${tagName} not found`);
      return tagObj;
    }
    return tags.find((t) => t.identify?.(value) && !t.format);
  }
  function createNode(value, tagName, ctx) {
    if (identity.isDocument(value))
      value = value.contents;
    if (identity.isNode(value))
      return value;
    if (identity.isPair(value)) {
      const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
      map.items.push(value);
      return map;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
      value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === "object") {
      ref = sourceObjects.get(value);
      if (ref) {
        ref.anchor ?? (ref.anchor = onAnchor(value));
        return new Alias.Alias(ref.anchor);
      } else {
        ref = { anchor: null, node: null };
        sourceObjects.set(value, ref);
      }
    }
    if (tagName?.startsWith("!!"))
      tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
      if (value && typeof value.toJSON === "function") {
        value = value.toJSON();
      }
      if (!value || typeof value !== "object") {
        const node = new Scalar.Scalar(value);
        if (ref)
          ref.node = node;
        return node;
      }
      tagObj = value instanceof Map ? schema[identity.MAP] : (Symbol.iterator in Object(value)) ? schema[identity.SEQ] : schema[identity.MAP];
    }
    if (onTagObj) {
      onTagObj(tagObj);
      delete ctx.onTagObj;
    }
    const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
    if (tagName)
      node.tag = tagName;
    else if (!tagObj.default)
      node.tag = tagObj.tag;
    if (ref)
      ref.node = node;
    return node;
  }
  exports.createNode = createNode;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS(function(exports) {
  var createNode = require_createNode();
  var identity = require_identity();
  var Node = require_Node();
  function collectionFromPath(schema, path, value) {
    let v = value;
    for (let i = path.length - 1;i >= 0; --i) {
      const k = path[i];
      if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
        const a = [];
        a[k] = v;
        v = a;
      } else {
        v = new Map([[k, v]]);
      }
    }
    return createNode.createNode(v, undefined, {
      aliasDuplicateObjects: false,
      keepUndefined: false,
      onAnchor: () => {
        throw new Error("This should not happen, please report a bug.");
      },
      schema,
      sourceObjects: new Map
    });
  }
  var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

  class Collection extends Node.NodeBase {
    constructor(type, schema) {
      super(type);
      Object.defineProperty(this, "schema", {
        value: schema,
        configurable: true,
        enumerable: false,
        writable: true
      });
    }
    clone(schema) {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (schema)
        copy.schema = schema;
      copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    addIn(path, value) {
      if (isEmptyPath(path))
        this.add(value);
      else {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.addIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
    deleteIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.delete(key);
      const node = this.get(key, true);
      if (identity.isCollection(node))
        return node.deleteIn(rest);
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
    getIn(path, keepScalar) {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (rest.length === 0)
        return !keepScalar && identity.isScalar(node) ? node.value : node;
      else
        return identity.isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
    }
    hasAllNullValues(allowScalar) {
      return this.items.every((node) => {
        if (!identity.isPair(node))
          return false;
        const n = node.value;
        return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
      });
    }
    hasIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.has(key);
      const node = this.get(key, true);
      return identity.isCollection(node) ? node.hasIn(rest) : false;
    }
    setIn(path, value) {
      const [key, ...rest] = path;
      if (rest.length === 0) {
        this.set(key, value);
      } else {
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.setIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
  }
  exports.Collection = Collection;
  exports.collectionFromPath = collectionFromPath;
  exports.isEmptyPath = isEmptyPath;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS(function(exports) {
  var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
  function indentComment(comment, indent) {
    if (/^\n+$/.test(comment))
      return comment.substring(1);
    return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
  }
  var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
  exports.indentComment = indentComment;
  exports.lineComment = lineComment;
  exports.stringifyComment = stringifyComment;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS(function(exports) {
  var FOLD_FLOW = "flow";
  var FOLD_BLOCK = "block";
  var FOLD_QUOTED = "quoted";
  function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
    if (!lineWidth || lineWidth < 0)
      return text;
    if (lineWidth < minContentWidth)
      minContentWidth = 0;
    const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
    if (text.length <= endStep)
      return text;
    const folds = [];
    const escapedFolds = {};
    let end = lineWidth - indent.length;
    if (typeof indentAtStart === "number") {
      if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
        folds.push(0);
      else
        end = lineWidth - indentAtStart;
    }
    let split = undefined;
    let prev = undefined;
    let overflow = false;
    let i = -1;
    let escStart = -1;
    let escEnd = -1;
    if (mode === FOLD_BLOCK) {
      i = consumeMoreIndentedLines(text, i, indent.length);
      if (i !== -1)
        end = i + endStep;
    }
    for (let ch;ch = text[i += 1]; ) {
      if (mode === FOLD_QUOTED && ch === "\\") {
        escStart = i;
        switch (text[i + 1]) {
          case "x":
            i += 3;
            break;
          case "u":
            i += 5;
            break;
          case "U":
            i += 9;
            break;
          default:
            i += 1;
        }
        escEnd = i;
      }
      if (ch === `
`) {
        if (mode === FOLD_BLOCK)
          i = consumeMoreIndentedLines(text, i, indent.length);
        end = i + indent.length + endStep;
        split = undefined;
      } else {
        if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
          const next = text[i + 1];
          if (next && next !== " " && next !== `
` && next !== "\t")
            split = i;
        }
        if (i >= end) {
          if (split) {
            folds.push(split);
            end = split + endStep;
            split = undefined;
          } else if (mode === FOLD_QUOTED) {
            while (prev === " " || prev === "\t") {
              prev = ch;
              ch = text[i += 1];
              overflow = true;
            }
            const j = i > escEnd + 1 ? i - 2 : escStart - 1;
            if (escapedFolds[j])
              return text;
            folds.push(j);
            escapedFolds[j] = true;
            end = j + endStep;
            split = undefined;
          } else {
            overflow = true;
          }
        }
      }
      prev = ch;
    }
    if (overflow && onOverflow)
      onOverflow();
    if (folds.length === 0)
      return text;
    if (onFold)
      onFold();
    let res = text.slice(0, folds[0]);
    for (let i = 0;i < folds.length; ++i) {
      const fold = folds[i];
      const end = folds[i + 1] || text.length;
      if (fold === 0)
        res = `
${indent}${text.slice(0, end)}`;
      else {
        if (mode === FOLD_QUOTED && escapedFolds[fold])
          res += `${text[fold]}\\`;
        res += `
${indent}${text.slice(fold + 1, end)}`;
      }
    }
    return res;
  }
  function consumeMoreIndentedLines(text, i, indent) {
    let end = i;
    let start = i + 1;
    let ch = text[start];
    while (ch === " " || ch === "\t") {
      if (i < start + indent) {
        ch = text[++i];
      } else {
        do {
          ch = text[++i];
        } while (ch && ch !== `
`);
        end = i;
        start = i + 1;
        ch = text[start];
      }
    }
    return end;
  }
  exports.FOLD_BLOCK = FOLD_BLOCK;
  exports.FOLD_FLOW = FOLD_FLOW;
  exports.FOLD_QUOTED = FOLD_QUOTED;
  exports.foldFlowLines = foldFlowLines;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  var foldFlowLines = require_foldFlowLines();
  var getFoldOptions = (ctx, isBlock) => ({
    indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
    lineWidth: ctx.options.lineWidth,
    minContentWidth: ctx.options.minContentWidth
  });
  var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
  function lineLengthOverLimit(str, lineWidth, indentLength) {
    if (!lineWidth || lineWidth < 0)
      return false;
    const limit = lineWidth - indentLength;
    const strLen = str.length;
    if (strLen <= limit)
      return false;
    for (let i = 0, start = 0;i < strLen; ++i) {
      if (str[i] === `
`) {
        if (i - start > limit)
          return true;
        start = i + 1;
        if (strLen - start <= limit)
          return false;
      }
    }
    return true;
  }
  function doubleQuotedString(value, ctx) {
    const json = JSON.stringify(value);
    if (ctx.options.doubleQuotedAsJSON)
      return json;
    const { implicitKey } = ctx;
    const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    let str = "";
    let start = 0;
    for (let i = 0, ch = json[i];ch; ch = json[++i]) {
      if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
        str += json.slice(start, i) + "\\ ";
        i += 1;
        start = i;
        ch = "\\";
      }
      if (ch === "\\")
        switch (json[i + 1]) {
          case "u":
            {
              str += json.slice(start, i);
              const code = json.substr(i + 2, 4);
              switch (code) {
                case "0000":
                  str += "\\0";
                  break;
                case "0007":
                  str += "\\a";
                  break;
                case "000b":
                  str += "\\v";
                  break;
                case "001b":
                  str += "\\e";
                  break;
                case "0085":
                  str += "\\N";
                  break;
                case "00a0":
                  str += "\\_";
                  break;
                case "2028":
                  str += "\\L";
                  break;
                case "2029":
                  str += "\\P";
                  break;
                default:
                  if (code.substr(0, 2) === "00")
                    str += "\\x" + code.substr(2);
                  else
                    str += json.substr(i, 6);
              }
              i += 5;
              start = i + 1;
            }
            break;
          case "n":
            if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
              i += 1;
            } else {
              str += json.slice(start, i) + `

`;
              while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                str += `
`;
                i += 2;
              }
              str += indent;
              if (json[i + 2] === " ")
                str += "\\";
              i += 1;
              start = i + 1;
            }
            break;
          default:
            i += 1;
        }
    }
    str = start ? str + json.slice(start) : json;
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
  }
  function singleQuotedString(value, ctx) {
    if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
      return doubleQuotedString(value, ctx);
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
    return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function quotedString(value, ctx) {
    const { singleQuote } = ctx.options;
    let qs;
    if (singleQuote === false)
      qs = doubleQuotedString;
    else {
      const hasDouble = value.includes('"');
      const hasSingle = value.includes("'");
      if (hasDouble && !hasSingle)
        qs = singleQuotedString;
      else if (hasSingle && !hasDouble)
        qs = doubleQuotedString;
      else
        qs = singleQuote ? singleQuotedString : doubleQuotedString;
    }
    return qs(value, ctx);
  }
  var blockEndNewlines;
  try {
    blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
  } catch {
    blockEndNewlines = /\n+(?!\n|$)/g;
  }
  function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
    const { blockQuote, commentString, lineWidth } = ctx.options;
    if (!blockQuote || /\n[\t ]+$/.test(value)) {
      return quotedString(value, ctx);
    }
    const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
    const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
    if (!value)
      return literal ? `|
` : `>
`;
    let chomp;
    let endStart;
    for (endStart = value.length;endStart > 0; --endStart) {
      const ch = value[endStart - 1];
      if (ch !== `
` && ch !== "\t" && ch !== " ")
        break;
    }
    let end = value.substring(endStart);
    const endNlPos = end.indexOf(`
`);
    if (endNlPos === -1) {
      chomp = "-";
    } else if (value === end || endNlPos !== end.length - 1) {
      chomp = "+";
      if (onChompKeep)
        onChompKeep();
    } else {
      chomp = "";
    }
    if (end) {
      value = value.slice(0, -end.length);
      if (end[end.length - 1] === `
`)
        end = end.slice(0, -1);
      end = end.replace(blockEndNewlines, `$&${indent}`);
    }
    let startWithSpace = false;
    let startEnd;
    let startNlPos = -1;
    for (startEnd = 0;startEnd < value.length; ++startEnd) {
      const ch = value[startEnd];
      if (ch === " ")
        startWithSpace = true;
      else if (ch === `
`)
        startNlPos = startEnd;
      else
        break;
    }
    let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
    if (start) {
      value = value.substring(start.length);
      start = start.replace(/\n+/g, `$&${indent}`);
    }
    const indentSize = indent ? "2" : "1";
    let header = (startWithSpace ? indentSize : "") + chomp;
    if (comment) {
      header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
      if (onComment)
        onComment();
    }
    if (!literal) {
      const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
      let literalFallback = false;
      const foldOptions = getFoldOptions(ctx, true);
      if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
        foldOptions.onOverflow = () => {
          literalFallback = true;
        };
      }
      const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
      if (!literalFallback)
        return `>${header}
${indent}${body}`;
    }
    value = value.replace(/\n+/g, `$&${indent}`);
    return `|${header}
${indent}${start}${value}${end}`;
  }
  function plainString(item, ctx, onComment, onChompKeep) {
    const { type, value } = item;
    const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
    if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
      return quotedString(value, ctx);
    }
    if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
      return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
    }
    if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes(`
`)) {
      return blockString(item, ctx, onComment, onChompKeep);
    }
    if (containsDocumentMarker(value)) {
      if (indent === "") {
        ctx.forceBlockIndent = true;
        return blockString(item, ctx, onComment, onChompKeep);
      } else if (implicitKey && indent === indentStep) {
        return quotedString(value, ctx);
      }
    }
    const str = value.replace(/\n+/g, `$&
${indent}`);
    if (actualString) {
      const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
      const { compat, tags } = ctx.doc.schema;
      if (tags.some(test) || compat?.some(test))
        return quotedString(value, ctx);
    }
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function stringifyString(item, ctx, onComment, onChompKeep) {
    const { implicitKey, inFlow } = ctx;
    const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
    let { type } = item;
    if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
        type = Scalar.Scalar.QUOTE_DOUBLE;
    }
    const _stringify = (_type) => {
      switch (_type) {
        case Scalar.Scalar.BLOCK_FOLDED:
        case Scalar.Scalar.BLOCK_LITERAL:
          return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
        case Scalar.Scalar.QUOTE_DOUBLE:
          return doubleQuotedString(ss.value, ctx);
        case Scalar.Scalar.QUOTE_SINGLE:
          return singleQuotedString(ss.value, ctx);
        case Scalar.Scalar.PLAIN:
          return plainString(ss, ctx, onComment, onChompKeep);
        default:
          return null;
      }
    };
    let res = _stringify(type);
    if (res === null) {
      const { defaultKeyType, defaultStringType } = ctx.options;
      const t = implicitKey && defaultKeyType || defaultStringType;
      res = _stringify(t);
      if (res === null)
        throw new Error(`Unsupported default string type ${t}`);
    }
    return res;
  }
  exports.stringifyString = stringifyString;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS(function(exports) {
  var anchors = require_anchors();
  var identity = require_identity();
  var stringifyComment = require_stringifyComment();
  var stringifyString = require_stringifyString();
  function createStringifyContext(doc, options) {
    const opt = Object.assign({
      blockQuote: true,
      commentString: stringifyComment.stringifyComment,
      defaultKeyType: null,
      defaultStringType: "PLAIN",
      directives: null,
      doubleQuotedAsJSON: false,
      doubleQuotedMinMultiLineLength: 40,
      falseStr: "false",
      flowCollectionPadding: true,
      indentSeq: true,
      lineWidth: 80,
      minContentWidth: 20,
      nullStr: "null",
      simpleKeys: false,
      singleQuote: null,
      trailingComma: false,
      trueStr: "true",
      verifyAliasOrder: true
    }, doc.schema.toStringOptions, options);
    let inFlow;
    switch (opt.collectionStyle) {
      case "block":
        inFlow = false;
        break;
      case "flow":
        inFlow = true;
        break;
      default:
        inFlow = null;
    }
    return {
      anchors: new Set,
      doc,
      flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
      indent: "",
      indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
      inFlow,
      options: opt
    };
  }
  function getTagObject(tags, item) {
    if (item.tag) {
      const match = tags.filter((t) => t.tag === item.tag);
      if (match.length > 0)
        return match.find((t) => t.format === item.format) ?? match[0];
    }
    let tagObj = undefined;
    let obj;
    if (identity.isScalar(item)) {
      obj = item.value;
      let match = tags.filter((t) => t.identify?.(obj));
      if (match.length > 1) {
        const testMatch = match.filter((t) => t.test);
        if (testMatch.length > 0)
          match = testMatch;
      }
      tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
    } else {
      obj = item;
      tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
    }
    if (!tagObj) {
      const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
      throw new Error(`Tag not resolved for ${name} value`);
    }
    return tagObj;
  }
  function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
    if (!doc.directives)
      return "";
    const props = [];
    const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
    if (anchor && anchors.anchorIsValid(anchor)) {
      anchors$1.add(anchor);
      props.push(`&${anchor}`);
    }
    const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
    if (tag)
      props.push(doc.directives.tagString(tag));
    return props.join(" ");
  }
  function stringify(item, ctx, onComment, onChompKeep) {
    if (identity.isPair(item))
      return item.toString(ctx, onComment, onChompKeep);
    if (identity.isAlias(item)) {
      if (ctx.doc.directives)
        return item.toString(ctx);
      if (ctx.resolvedAliases?.has(item)) {
        throw new TypeError(`Cannot stringify circular structure without alias nodes`);
      } else {
        if (ctx.resolvedAliases)
          ctx.resolvedAliases.add(item);
        else
          ctx.resolvedAliases = new Set([item]);
        item = item.resolve(ctx.doc);
      }
    }
    let tagObj = undefined;
    const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
    tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
    const props = stringifyProps(node, tagObj, ctx);
    if (props.length > 0)
      ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
    const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
    if (!props)
      return str;
    return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
  }
  exports.createStringifyContext = createStringifyContext;
  exports.stringify = stringify;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS(function(exports) {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
    const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
    let keyComment = identity.isNode(key) && key.comment || null;
    if (simpleKeys) {
      if (keyComment) {
        throw new Error("With simple keys, key nodes cannot have comments");
      }
      if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
        const msg = "With simple keys, collection cannot be used as a key value";
        throw new Error(msg);
      }
    }
    let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
    ctx = Object.assign({}, ctx, {
      allNullValues: false,
      implicitKey: !explicitKey && (simpleKeys || !allNullValues),
      indent: indent + indentStep
    });
    let keyCommentDone = false;
    let chompKeep = false;
    let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
    if (!explicitKey && !ctx.inFlow && str.length > 1024) {
      if (simpleKeys)
        throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
      explicitKey = true;
    }
    if (ctx.inFlow) {
      if (allNullValues || value == null) {
        if (keyCommentDone && onComment)
          onComment();
        return str === "" ? "?" : explicitKey ? `? ${str}` : str;
      }
    } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
      str = `? ${str}`;
      if (keyComment && !keyCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    if (keyCommentDone)
      keyComment = null;
    if (explicitKey) {
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      str = `? ${str}
${indent}:`;
    } else {
      str = `${str}:`;
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
    }
    let vsb, vcb, valueComment;
    if (identity.isNode(value)) {
      vsb = !!value.spaceBefore;
      vcb = value.commentBefore;
      valueComment = value.comment;
    } else {
      vsb = false;
      vcb = null;
      valueComment = null;
      if (value && typeof value === "object")
        value = doc.createNode(value);
    }
    ctx.implicitKey = false;
    if (!explicitKey && !keyComment && identity.isScalar(value))
      ctx.indentAtStart = str.length + 1;
    chompKeep = false;
    if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
      ctx.indent = ctx.indent.substring(2);
    }
    let valueCommentDone = false;
    const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
    let ws = " ";
    if (keyComment || vsb || vcb) {
      ws = vsb ? `
` : "";
      if (vcb) {
        const cs = commentString(vcb);
        ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
      }
      if (valueStr === "" && !ctx.inFlow) {
        if (ws === `
` && valueComment)
          ws = `

`;
      } else {
        ws += `
${ctx.indent}`;
      }
    } else if (!explicitKey && identity.isCollection(value)) {
      const vs0 = valueStr[0];
      const nl0 = valueStr.indexOf(`
`);
      const hasNewline = nl0 !== -1;
      const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
      if (hasNewline || !flow) {
        let hasPropsLine = false;
        if (hasNewline && (vs0 === "&" || vs0 === "!")) {
          let sp0 = valueStr.indexOf(" ");
          if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
            sp0 = valueStr.indexOf(" ", sp0 + 1);
          }
          if (sp0 === -1 || nl0 < sp0)
            hasPropsLine = true;
        }
        if (!hasPropsLine)
          ws = `
${ctx.indent}`;
      }
    } else if (valueStr === "" || valueStr[0] === `
`) {
      ws = "";
    }
    str += ws + valueStr;
    if (ctx.inFlow) {
      if (valueCommentDone && onComment)
        onComment();
    } else if (valueComment && !valueCommentDone) {
      str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
    } else if (chompKeep && onChompKeep) {
      onChompKeep();
    }
    return str;
  }
  exports.stringifyPair = stringifyPair;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/log.js
var require_log = __commonJS(function(exports) {
  var node_process = __require("process");
  function debug(logLevel, ...messages) {
    if (logLevel === "debug")
      console.log(...messages);
  }
  function warn(logLevel, warning) {
    if (logLevel === "debug" || logLevel === "warn") {
      if (typeof node_process.emitWarning === "function")
        node_process.emitWarning(warning);
      else
        console.warn(warning);
    }
  }
  exports.debug = debug;
  exports.warn = warn;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS(function(exports) {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var MERGE_KEY = "<<";
  var merge = {
    identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
    default: "key",
    tag: "tag:yaml.org,2002:merge",
    test: /^<<$/,
    resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
      addToJSMap: addMergeToJSMap
    }),
    stringify: () => MERGE_KEY
  };
  var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
  function addMergeToJSMap(ctx, map, value) {
    const source = resolveAliasValue(ctx, value);
    if (identity.isSeq(source))
      for (const it of source.items)
        mergeValue(ctx, map, it);
    else if (Array.isArray(source))
      for (const it of source)
        mergeValue(ctx, map, it);
    else
      mergeValue(ctx, map, source);
  }
  function mergeValue(ctx, map, value) {
    const source = resolveAliasValue(ctx, value);
    if (!identity.isMap(source))
      throw new Error("Merge sources must be maps or map aliases");
    const srcMap = source.toJSON(null, ctx, Map);
    for (const [key, value] of srcMap) {
      if (map instanceof Map) {
        if (!map.has(key))
          map.set(key, value);
      } else if (map instanceof Set) {
        map.add(key);
      } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
        Object.defineProperty(map, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }
    return map;
  }
  function resolveAliasValue(ctx, value) {
    return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
  }
  exports.addMergeToJSMap = addMergeToJSMap;
  exports.isMergeKey = isMergeKey;
  exports.merge = merge;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS(function(exports) {
  var log = require_log();
  var merge = require_merge();
  var stringify = require_stringify();
  var identity = require_identity();
  var toJS = require_toJS();
  function addPairToJSMap(ctx, map, { key, value }) {
    if (identity.isNode(key) && key.addToJSMap)
      key.addToJSMap(ctx, map, value);
    else if (merge.isMergeKey(ctx, key))
      merge.addMergeToJSMap(ctx, map, value);
    else {
      const jsKey = toJS.toJS(key, "", ctx);
      if (map instanceof Map) {
        map.set(jsKey, toJS.toJS(value, jsKey, ctx));
      } else if (map instanceof Set) {
        map.add(jsKey);
      } else {
        const stringKey = stringifyKey(key, jsKey, ctx);
        const jsValue = toJS.toJS(value, stringKey, ctx);
        if (stringKey in map)
          Object.defineProperty(map, stringKey, {
            value: jsValue,
            writable: true,
            enumerable: true,
            configurable: true
          });
        else
          map[stringKey] = jsValue;
      }
    }
    return map;
  }
  function stringifyKey(key, jsKey, ctx) {
    if (jsKey === null)
      return "";
    if (typeof jsKey !== "object")
      return String(jsKey);
    if (identity.isNode(key) && ctx?.doc) {
      const strCtx = stringify.createStringifyContext(ctx.doc, {});
      strCtx.anchors = new Set;
      for (const node of ctx.anchors.keys())
        strCtx.anchors.add(node.anchor);
      strCtx.inFlow = true;
      strCtx.inStringifyKey = true;
      const strKey = key.toString(strCtx);
      if (!ctx.mapKeyWarned) {
        let jsonStr = JSON.stringify(strKey);
        if (jsonStr.length > 40)
          jsonStr = jsonStr.substring(0, 36) + '..."';
        log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
        ctx.mapKeyWarned = true;
      }
      return strKey;
    }
    return JSON.stringify(jsKey);
  }
  exports.addPairToJSMap = addPairToJSMap;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS(function(exports) {
  var createNode = require_createNode();
  var stringifyPair = require_stringifyPair();
  var addPairToJSMap = require_addPairToJSMap();
  var identity = require_identity();
  function createPair(key, value, ctx) {
    const k = createNode.createNode(key, undefined, ctx);
    const v = createNode.createNode(value, undefined, ctx);
    return new Pair(k, v);
  }

  class Pair {
    constructor(key, value = null) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
      this.key = key;
      this.value = value;
    }
    clone(schema) {
      let { key, value } = this;
      if (identity.isNode(key))
        key = key.clone(schema);
      if (identity.isNode(value))
        value = value.clone(schema);
      return new Pair(key, value);
    }
    toJSON(_, ctx) {
      const pair = ctx?.mapAsMap ? new Map : {};
      return addPairToJSMap.addPairToJSMap(ctx, pair, this);
    }
    toString(ctx, onComment, onChompKeep) {
      return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
    }
  }
  exports.Pair = Pair;
  exports.createPair = createPair;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS(function(exports) {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyCollection(collection, ctx, options) {
    const flow = ctx.inFlow ?? collection.flow;
    const stringify = flow ? stringifyFlowCollection : stringifyBlockCollection;
    return stringify(collection, ctx, options);
  }
  function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
    const { indent, options: { commentString } } = ctx;
    const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
    let chompKeep = false;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (!chompKeep && item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
        if (item.comment)
          comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (!chompKeep && ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
        }
      }
      chompKeep = false;
      let str = stringify.stringify(item, itemCtx, () => comment = null, () => chompKeep = true);
      if (comment)
        str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      if (chompKeep && comment)
        chompKeep = false;
      lines.push(blockItemPrefix + str);
    }
    let str;
    if (lines.length === 0) {
      str = flowChars.start + flowChars.end;
    } else {
      str = lines[0];
      for (let i = 1;i < lines.length; ++i) {
        const line = lines[i];
        str += line ? `
${indent}${line}` : `
`;
      }
    }
    if (comment) {
      str += `
` + stringifyComment.indentComment(commentString(comment), indent);
      if (onComment)
        onComment();
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
    const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
    itemIndent += indentStep;
    const itemCtx = Object.assign({}, ctx, {
      indent: itemIndent,
      inFlow: true,
      type: null
    });
    let reqNewline = false;
    let linesAtValue = 0;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, false);
        if (item.comment)
          comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, false);
          if (ik.comment)
            reqNewline = true;
        }
        const iv = identity.isNode(item.value) ? item.value : null;
        if (iv) {
          if (iv.comment)
            comment = iv.comment;
          if (iv.commentBefore)
            reqNewline = true;
        } else if (item.value == null && ik?.comment) {
          comment = ik.comment;
        }
      }
      if (comment)
        reqNewline = true;
      let str = stringify.stringify(item, itemCtx, () => comment = null);
      reqNewline || (reqNewline = lines.length > linesAtValue || str.includes(`
`));
      if (i < items.length - 1) {
        str += ",";
      } else if (ctx.options.trailingComma) {
        if (ctx.options.lineWidth > 0) {
          reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
        }
        if (reqNewline) {
          str += ",";
        }
      }
      if (comment)
        str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      lines.push(str);
      linesAtValue = lines.length;
    }
    const { start, end } = flowChars;
    if (lines.length === 0) {
      return start + end;
    } else {
      if (!reqNewline) {
        const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
        reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
      }
      if (reqNewline) {
        let str = start;
        for (const line of lines)
          str += line ? `
${indentStep}${indent}${line}` : `
`;
        return `${str}
${indent}${end}`;
      } else {
        return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
      }
    }
  }
  function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
    if (comment && chompKeep)
      comment = comment.replace(/^\n+/, "");
    if (comment) {
      const ic = stringifyComment.indentComment(commentString(comment), indent);
      lines.push(ic.trimStart());
    }
  }
  exports.stringifyCollection = stringifyCollection;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS(function(exports) {
  var stringifyCollection = require_stringifyCollection();
  var addPairToJSMap = require_addPairToJSMap();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  function findPair(items, key) {
    const k = identity.isScalar(key) ? key.value : key;
    for (const it of items) {
      if (identity.isPair(it)) {
        if (it.key === key || it.key === k)
          return it;
        if (identity.isScalar(it.key) && it.key.value === k)
          return it;
      }
    }
    return;
  }

  class YAMLMap extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:map";
    }
    constructor(schema) {
      super(identity.MAP, schema);
      this.items = [];
    }
    static from(schema, obj, ctx) {
      const { keepUndefined, replacer } = ctx;
      const map = new this(schema);
      const add = (key, value) => {
        if (typeof replacer === "function")
          value = replacer.call(obj, key, value);
        else if (Array.isArray(replacer) && !replacer.includes(key))
          return;
        if (value !== undefined || keepUndefined)
          map.items.push(Pair.createPair(key, value, ctx));
      };
      if (obj instanceof Map) {
        for (const [key, value] of obj)
          add(key, value);
      } else if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj))
          add(key, obj[key]);
      }
      if (typeof schema.sortMapEntries === "function") {
        map.items.sort(schema.sortMapEntries);
      }
      return map;
    }
    add(pair, overwrite) {
      let _pair;
      if (identity.isPair(pair))
        _pair = pair;
      else if (!pair || typeof pair !== "object" || !("key" in pair)) {
        _pair = new Pair.Pair(pair, pair?.value);
      } else
        _pair = new Pair.Pair(pair.key, pair.value);
      const prev = findPair(this.items, _pair.key);
      const sortEntries = this.schema?.sortMapEntries;
      if (prev) {
        if (!overwrite)
          throw new Error(`Key ${_pair.key} already set`);
        if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
          prev.value.value = _pair.value;
        else
          prev.value = _pair.value;
      } else if (sortEntries) {
        const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
        if (i === -1)
          this.items.push(_pair);
        else
          this.items.splice(i, 0, _pair);
      } else {
        this.items.push(_pair);
      }
    }
    delete(key) {
      const it = findPair(this.items, key);
      if (!it)
        return false;
      const del = this.items.splice(this.items.indexOf(it), 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const it = findPair(this.items, key);
      const node = it?.value;
      return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? undefined;
    }
    has(key) {
      return !!findPair(this.items, key);
    }
    set(key, value) {
      this.add(new Pair.Pair(key, value), true);
    }
    toJSON(_, ctx, Type) {
      const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const item of this.items)
        addPairToJSMap.addPairToJSMap(ctx, map, item);
      return map;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      for (const item of this.items) {
        if (!identity.isPair(item))
          throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
      }
      if (!ctx.allNullValues && this.hasAllNullValues(false))
        ctx = Object.assign({}, ctx, { allNullValues: true });
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "",
        flowChars: { start: "{", end: "}" },
        itemIndent: ctx.indent || "",
        onChompKeep,
        onComment
      });
    }
  }
  exports.YAMLMap = YAMLMap;
  exports.findPair = findPair;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS(function(exports) {
  var identity = require_identity();
  var YAMLMap = require_YAMLMap();
  var map = {
    collection: "map",
    default: true,
    nodeClass: YAMLMap.YAMLMap,
    tag: "tag:yaml.org,2002:map",
    resolve(map, onError) {
      if (!identity.isMap(map))
        onError("Expected a mapping for this tag");
      return map;
    },
    createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
  };
  exports.map = map;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS(function(exports) {
  var createNode = require_createNode();
  var stringifyCollection = require_stringifyCollection();
  var Collection = require_Collection();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var toJS = require_toJS();

  class YAMLSeq extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:seq";
    }
    constructor(schema) {
      super(identity.SEQ, schema);
      this.items = [];
    }
    add(value) {
      this.items.push(value);
    }
    delete(key) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return false;
      const del = this.items.splice(idx, 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return;
      const it = this.items[idx];
      return !keepScalar && identity.isScalar(it) ? it.value : it;
    }
    has(key) {
      const idx = asItemIndex(key);
      return typeof idx === "number" && idx < this.items.length;
    }
    set(key, value) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        throw new Error(`Expected a valid index, not ${key}.`);
      const prev = this.items[idx];
      if (identity.isScalar(prev) && Scalar.isScalarValue(value))
        prev.value = value;
      else
        this.items[idx] = value;
    }
    toJSON(_, ctx) {
      const seq = [];
      if (ctx?.onCreate)
        ctx.onCreate(seq);
      let i = 0;
      for (const item of this.items)
        seq.push(toJS.toJS(item, String(i++), ctx));
      return seq;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "- ",
        flowChars: { start: "[", end: "]" },
        itemIndent: (ctx.indent || "") + "  ",
        onChompKeep,
        onComment
      });
    }
    static from(schema, obj, ctx) {
      const { replacer } = ctx;
      const seq = new this(schema);
      if (obj && Symbol.iterator in Object(obj)) {
        let i = 0;
        for (let it of obj) {
          if (typeof replacer === "function") {
            const key = obj instanceof Set ? it : String(i++);
            it = replacer.call(obj, key, it);
          }
          seq.items.push(createNode.createNode(it, undefined, ctx));
        }
      }
      return seq;
    }
  }
  function asItemIndex(key) {
    let idx = identity.isScalar(key) ? key.value : key;
    if (idx && typeof idx === "string")
      idx = Number(idx);
    return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
  }
  exports.YAMLSeq = YAMLSeq;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS(function(exports) {
  var identity = require_identity();
  var YAMLSeq = require_YAMLSeq();
  var seq = {
    collection: "seq",
    default: true,
    nodeClass: YAMLSeq.YAMLSeq,
    tag: "tag:yaml.org,2002:seq",
    resolve(seq, onError) {
      if (!identity.isSeq(seq))
        onError("Expected a sequence for this tag");
      return seq;
    },
    createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
  };
  exports.seq = seq;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS(function(exports) {
  var stringifyString = require_stringifyString();
  var string = {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify(item, ctx, onComment, onChompKeep) {
      ctx = Object.assign({ actualString: true }, ctx);
      return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
    }
  };
  exports.string = string;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  var nullTag = {
    identify: (value) => value == null,
    createNode: () => new Scalar.Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar.Scalar(null),
    stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
  };
  exports.nullTag = nullTag;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  var boolTag = {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
    resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
    stringify({ source, value }, ctx) {
      if (source && boolTag.test.test(source)) {
        const sv = source[0] === "t" || source[0] === "T";
        if (value === sv)
          return source;
      }
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
  };
  exports.boolTag = boolTag;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS(function(exports) {
  function stringifyNumber({ format, minFractionDigits, tag, value }) {
    if (typeof value === "bigint")
      return String(value);
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num))
      return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
    let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
      let i = n.indexOf(".");
      if (i < 0) {
        i = n.length;
        n += ".";
      }
      let d = minFractionDigits - (n.length - i - 1);
      while (d-- > 0)
        n += "0";
    }
    return n;
  }
  exports.stringifyNumber = stringifyNumber;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str));
      const dot = str.indexOf(".");
      if (dot !== -1 && str[str.length - 1] === "0")
        node.minFractionDigits = str.length - dot - 1;
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS(function(exports) {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value) && value >= 0)
      return prefix + value.toString(radix);
    return stringifyNumber.stringifyNumber(node);
  }
  var intOct = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^0o[0-7]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
    stringify: (node) => intStringify(node, 8, "0o")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^0x[0-9a-fA-F]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS(function(exports) {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.boolTag,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float
  ];
  exports.schema = schema;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  var map = require_map();
  var seq = require_seq();
  function intIdentify(value) {
    return typeof value === "bigint" || Number.isInteger(value);
  }
  var stringifyJSON = ({ value }) => JSON.stringify(value);
  var jsonScalars = [
    {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify: stringifyJSON
    },
    {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^null$/,
      resolve: () => null,
      stringify: stringifyJSON
    },
    {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^true$|^false$/,
      resolve: (str) => str === "true",
      stringify: stringifyJSON
    },
    {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^-?(?:0|[1-9][0-9]*)$/,
      resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
      stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
    },
    {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
      resolve: (str) => parseFloat(str),
      stringify: stringifyJSON
    }
  ];
  var jsonError = {
    default: true,
    tag: "",
    test: /^/,
    resolve(str, onError) {
      onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
      return str;
    }
  };
  var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
  exports.schema = schema;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS(function(exports) {
  var node_buffer = __require("buffer");
  var Scalar = require_Scalar();
  var stringifyString = require_stringifyString();
  var binary = {
    identify: (value) => value instanceof Uint8Array,
    default: false,
    tag: "tag:yaml.org,2002:binary",
    resolve(src, onError) {
      if (typeof node_buffer.Buffer === "function") {
        return node_buffer.Buffer.from(src, "base64");
      } else if (typeof atob === "function") {
        const str = atob(src.replace(/[\n\r]/g, ""));
        const buffer = new Uint8Array(str.length);
        for (let i = 0;i < str.length; ++i)
          buffer[i] = str.charCodeAt(i);
        return buffer;
      } else {
        onError("This environment does not support reading binary tags; either Buffer or atob is required");
        return src;
      }
    },
    stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
      if (!value)
        return "";
      const buf = value;
      let str;
      if (typeof node_buffer.Buffer === "function") {
        str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
      } else if (typeof btoa === "function") {
        let s = "";
        for (let i = 0;i < buf.length; ++i)
          s += String.fromCharCode(buf[i]);
        str = btoa(s);
      } else {
        throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
      }
      type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
        const n = Math.ceil(str.length / lineWidth);
        const lines = new Array(n);
        for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
          lines[i] = str.substr(o, lineWidth);
        }
        str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? `
` : " ");
      }
      return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
    }
  };
  exports.binary = binary;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS(function(exports) {
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLSeq = require_YAMLSeq();
  function resolvePairs(seq, onError) {
    if (identity.isSeq(seq)) {
      for (let i = 0;i < seq.items.length; ++i) {
        let item = seq.items[i];
        if (identity.isPair(item))
          continue;
        else if (identity.isMap(item)) {
          if (item.items.length > 1)
            onError("Each pair must have its own sequence indicator");
          const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
          if (item.commentBefore)
            pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
          if (item.comment) {
            const cn = pair.value ?? pair.key;
            cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
          }
          item = pair;
        }
        seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
      }
    } else
      onError("Expected a sequence for this tag");
    return seq;
  }
  function createPairs(schema, iterable, ctx) {
    const { replacer } = ctx;
    const pairs = new YAMLSeq.YAMLSeq(schema);
    pairs.tag = "tag:yaml.org,2002:pairs";
    let i = 0;
    if (iterable && Symbol.iterator in Object(iterable))
      for (let it of iterable) {
        if (typeof replacer === "function")
          it = replacer.call(iterable, String(i++), it);
        let key, value;
        if (Array.isArray(it)) {
          if (it.length === 2) {
            key = it[0];
            value = it[1];
          } else
            throw new TypeError(`Expected [key, value] tuple: ${it}`);
        } else if (it && it instanceof Object) {
          const keys = Object.keys(it);
          if (keys.length === 1) {
            key = keys[0];
            value = it[key];
          } else {
            throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
          }
        } else {
          key = it;
        }
        pairs.items.push(Pair.createPair(key, value, ctx));
      }
    return pairs;
  }
  var pairs = {
    collection: "seq",
    default: false,
    tag: "tag:yaml.org,2002:pairs",
    resolve: resolvePairs,
    createNode: createPairs
  };
  exports.createPairs = createPairs;
  exports.pairs = pairs;
  exports.resolvePairs = resolvePairs;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS(function(exports) {
  var identity = require_identity();
  var toJS = require_toJS();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var pairs = require_pairs();

  class YAMLOMap extends YAMLSeq.YAMLSeq {
    constructor() {
      super();
      this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
      this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
      this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
      this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
      this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
      this.tag = YAMLOMap.tag;
    }
    toJSON(_, ctx) {
      if (!ctx)
        return super.toJSON(_);
      const map = new Map;
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const pair of this.items) {
        let key, value;
        if (identity.isPair(pair)) {
          key = toJS.toJS(pair.key, "", ctx);
          value = toJS.toJS(pair.value, key, ctx);
        } else {
          key = toJS.toJS(pair, "", ctx);
        }
        if (map.has(key))
          throw new Error("Ordered maps must not include duplicate keys");
        map.set(key, value);
      }
      return map;
    }
    static from(schema, iterable, ctx) {
      const pairs$1 = pairs.createPairs(schema, iterable, ctx);
      const omap = new this;
      omap.items = pairs$1.items;
      return omap;
    }
  }
  YAMLOMap.tag = "tag:yaml.org,2002:omap";
  var omap = {
    collection: "seq",
    identify: (value) => value instanceof Map,
    nodeClass: YAMLOMap,
    default: false,
    tag: "tag:yaml.org,2002:omap",
    resolve(seq, onError) {
      const pairs$1 = pairs.resolvePairs(seq, onError);
      const seenKeys = [];
      for (const { key } of pairs$1.items) {
        if (identity.isScalar(key)) {
          if (seenKeys.includes(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${key.value}`);
          } else {
            seenKeys.push(key.value);
          }
        }
      }
      return Object.assign(new YAMLOMap, pairs$1);
    },
    createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
  };
  exports.YAMLOMap = YAMLOMap;
  exports.omap = omap;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  function boolStringify({ value, source }, ctx) {
    const boolObj = value ? trueTag : falseTag;
    if (source && boolObj.test.test(source))
      return source;
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
  var trueTag = {
    identify: (value) => value === true,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
    resolve: () => new Scalar.Scalar(true),
    stringify: boolStringify
  };
  var falseTag = {
    identify: (value) => value === false,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
    resolve: () => new Scalar.Scalar(false),
    stringify: boolStringify
  };
  exports.falseTag = falseTag;
  exports.trueTag = trueTag;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str.replace(/_/g, "")),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
      const dot = str.indexOf(".");
      if (dot !== -1) {
        const f = str.substring(dot + 1).replace(/_/g, "");
        if (f[f.length - 1] === "0")
          node.minFractionDigits = f.length;
      }
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS(function(exports) {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  function intResolve(str, offset, radix, { intAsBigInt }) {
    const sign = str[0];
    if (sign === "-" || sign === "+")
      offset += 1;
    str = str.substring(offset).replace(/_/g, "");
    if (intAsBigInt) {
      switch (radix) {
        case 2:
          str = `0b${str}`;
          break;
        case 8:
          str = `0o${str}`;
          break;
        case 16:
          str = `0x${str}`;
          break;
      }
      const n = BigInt(str);
      return sign === "-" ? BigInt(-1) * n : n;
    }
    const n = parseInt(str, radix);
    return sign === "-" ? -1 * n : n;
  }
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value)) {
      const str = value.toString(radix);
      return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
    }
    return stringifyNumber.stringifyNumber(node);
  }
  var intBin = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "BIN",
    test: /^[-+]?0b[0-1_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
    stringify: (node) => intStringify(node, 2, "0b")
  };
  var intOct = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^[-+]?0[0-7_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
    stringify: (node) => intStringify(node, 8, "0")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9][0-9_]*$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^[-+]?0x[0-9a-fA-F_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intBin = intBin;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS(function(exports) {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();

  class YAMLSet extends YAMLMap.YAMLMap {
    constructor(schema) {
      super(schema);
      this.tag = YAMLSet.tag;
    }
    add(key) {
      let pair;
      if (identity.isPair(key))
        pair = key;
      else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
        pair = new Pair.Pair(key.key, null);
      else
        pair = new Pair.Pair(key, null);
      const prev = YAMLMap.findPair(this.items, pair.key);
      if (!prev)
        this.items.push(pair);
    }
    get(key, keepPair) {
      const pair = YAMLMap.findPair(this.items, key);
      return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
    }
    set(key, value) {
      if (typeof value !== "boolean")
        throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
      const prev = YAMLMap.findPair(this.items, key);
      if (prev && !value) {
        this.items.splice(this.items.indexOf(prev), 1);
      } else if (!prev && value) {
        this.items.push(new Pair.Pair(key));
      }
    }
    toJSON(_, ctx) {
      return super.toJSON(_, ctx, Set);
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      if (this.hasAllNullValues(true))
        return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
      else
        throw new Error("Set items must all have null values");
    }
    static from(schema, iterable, ctx) {
      const { replacer } = ctx;
      const set = new this(schema);
      if (iterable && Symbol.iterator in Object(iterable))
        for (let value of iterable) {
          if (typeof replacer === "function")
            value = replacer.call(iterable, value, value);
          set.items.push(Pair.createPair(value, null, ctx));
        }
      return set;
    }
  }
  YAMLSet.tag = "tag:yaml.org,2002:set";
  var set = {
    collection: "map",
    identify: (value) => value instanceof Set,
    nodeClass: YAMLSet,
    default: false,
    tag: "tag:yaml.org,2002:set",
    createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
    resolve(map, onError) {
      if (identity.isMap(map)) {
        if (map.hasAllNullValues(true))
          return Object.assign(new YAMLSet, map);
        else
          onError("Set items must all have null values");
      } else
        onError("Expected a mapping for this tag");
      return map;
    }
  };
  exports.YAMLSet = YAMLSet;
  exports.set = set;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS(function(exports) {
  var stringifyNumber = require_stringifyNumber();
  function parseSexagesimal(str, asBigInt) {
    const sign = str[0];
    const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
    const num = (n) => asBigInt ? BigInt(n) : Number(n);
    const res = parts.replace(/_/g, "").split(":").reduce((res, p) => res * num(60) + num(p), num(0));
    return sign === "-" ? num(-1) * res : res;
  }
  function stringifySexagesimal(node) {
    let { value } = node;
    let num = (n) => n;
    if (typeof value === "bigint")
      num = (n) => BigInt(n);
    else if (isNaN(value) || !isFinite(value))
      return stringifyNumber.stringifyNumber(node);
    let sign = "";
    if (value < 0) {
      sign = "-";
      value *= num(-1);
    }
    const _60 = num(60);
    const parts = [value % _60];
    if (value < 60) {
      parts.unshift(0);
    } else {
      value = (value - parts[0]) / _60;
      parts.unshift(value % _60);
      if (value >= 60) {
        value = (value - parts[0]) / _60;
        parts.unshift(value);
      }
    }
    return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
  }
  var intTime = {
    identify: (value) => typeof value === "bigint" || Number.isInteger(value),
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
    resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
    stringify: stringifySexagesimal
  };
  var floatTime = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
    resolve: (str) => parseSexagesimal(str, false),
    stringify: stringifySexagesimal
  };
  var timestamp = {
    identify: (value) => value instanceof Date,
    default: true,
    tag: "tag:yaml.org,2002:timestamp",
    test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
    resolve(str) {
      const match = str.match(timestamp.test);
      if (!match)
        throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
      const [, year, month, day, hour, minute, second] = match.map(Number);
      const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
      let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
      const tz = match[8];
      if (tz && tz !== "Z") {
        let d = parseSexagesimal(tz, false);
        if (Math.abs(d) < 30)
          d *= 60;
        date -= 60000 * d;
      }
      return new Date(date);
    },
    stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
  };
  exports.floatTime = floatTime;
  exports.intTime = intTime;
  exports.timestamp = timestamp;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS(function(exports) {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var binary = require_binary();
  var bool = require_bool2();
  var float = require_float2();
  var int = require_int2();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var set = require_set();
  var timestamp = require_timestamp();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.trueTag,
    bool.falseTag,
    int.intBin,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
    binary.binary,
    merge.merge,
    omap.omap,
    pairs.pairs,
    set.set,
    timestamp.intTime,
    timestamp.floatTime,
    timestamp.timestamp
  ];
  exports.schema = schema;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS(function(exports) {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = require_schema();
  var schema$1 = require_schema2();
  var binary = require_binary();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var schema$2 = require_schema3();
  var set = require_set();
  var timestamp = require_timestamp();
  var schemas = new Map([
    ["core", schema.schema],
    ["failsafe", [map.map, seq.seq, string.string]],
    ["json", schema$1.schema],
    ["yaml11", schema$2.schema],
    ["yaml-1.1", schema$2.schema]
  ]);
  var tagsByName = {
    binary: binary.binary,
    bool: bool.boolTag,
    float: float.float,
    floatExp: float.floatExp,
    floatNaN: float.floatNaN,
    floatTime: timestamp.floatTime,
    int: int.int,
    intHex: int.intHex,
    intOct: int.intOct,
    intTime: timestamp.intTime,
    map: map.map,
    merge: merge.merge,
    null: _null.nullTag,
    omap: omap.omap,
    pairs: pairs.pairs,
    seq: seq.seq,
    set: set.set,
    timestamp: timestamp.timestamp
  };
  var coreKnownTags = {
    "tag:yaml.org,2002:binary": binary.binary,
    "tag:yaml.org,2002:merge": merge.merge,
    "tag:yaml.org,2002:omap": omap.omap,
    "tag:yaml.org,2002:pairs": pairs.pairs,
    "tag:yaml.org,2002:set": set.set,
    "tag:yaml.org,2002:timestamp": timestamp.timestamp
  };
  function getTags(customTags, schemaName, addMergeTag) {
    const schemaTags = schemas.get(schemaName);
    if (schemaTags && !customTags) {
      return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
    }
    let tags = schemaTags;
    if (!tags) {
      if (Array.isArray(customTags))
        tags = [];
      else {
        const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
      }
    }
    if (Array.isArray(customTags)) {
      for (const tag of customTags)
        tags = tags.concat(tag);
    } else if (typeof customTags === "function") {
      tags = customTags(tags.slice());
    }
    if (addMergeTag)
      tags = tags.concat(merge.merge);
    return tags.reduce((tags, tag) => {
      const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
      if (!tagObj) {
        const tagName = JSON.stringify(tag);
        const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
      }
      if (!tags.includes(tagObj))
        tags.push(tagObj);
      return tags;
    }, []);
  }
  exports.coreKnownTags = coreKnownTags;
  exports.getTags = getTags;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS(function(exports) {
  var identity = require_identity();
  var map = require_map();
  var seq = require_seq();
  var string = require_string();
  var tags = require_tags();
  var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

  class Schema {
    constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
      this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
      this.name = typeof schema === "string" && schema || "core";
      this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
      this.tags = tags.getTags(customTags, this.name, merge);
      this.toStringOptions = toStringDefaults ?? null;
      Object.defineProperty(this, identity.MAP, { value: map.map });
      Object.defineProperty(this, identity.SCALAR, { value: string.string });
      Object.defineProperty(this, identity.SEQ, { value: seq.seq });
      this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
    }
    clone() {
      const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
      copy.tags = this.tags.slice();
      return copy;
    }
  }
  exports.Schema = Schema;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS(function(exports) {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false && doc.directives) {
      const dir = doc.directives.toString(doc);
      if (dir) {
        lines.push(dir);
        hasDirectives = true;
      } else if (doc.directives.docStart)
        hasDirectives = true;
    }
    if (hasDirectives)
      lines.push("---");
    const ctx = stringify.createStringifyContext(doc, options);
    const { commentString } = ctx.options;
    if (doc.commentBefore) {
      if (lines.length !== 1)
        lines.unshift("");
      const cs = commentString(doc.commentBefore);
      lines.unshift(stringifyComment.indentComment(cs, ""));
    }
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
      if (identity.isNode(doc.contents)) {
        if (doc.contents.spaceBefore && hasDirectives)
          lines.push("");
        if (doc.contents.commentBefore) {
          const cs = commentString(doc.contents.commentBefore);
          lines.push(stringifyComment.indentComment(cs, ""));
        }
        ctx.forceBlockIndent = !!doc.comment;
        contentComment = doc.contents.comment;
      }
      const onChompKeep = contentComment ? undefined : () => chompKeep = true;
      let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
      if (contentComment)
        body += stringifyComment.lineComment(body, "", commentString(contentComment));
      if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
        lines[lines.length - 1] = `--- ${body}`;
      } else
        lines.push(body);
    } else {
      lines.push(stringify.stringify(doc.contents, ctx));
    }
    if (doc.directives?.docEnd) {
      if (doc.comment) {
        const cs = commentString(doc.comment);
        if (cs.includes(`
`)) {
          lines.push("...");
          lines.push(stringifyComment.indentComment(cs, ""));
        } else {
          lines.push(`... ${cs}`);
        }
      } else {
        lines.push("...");
      }
    } else {
      let dc = doc.comment;
      if (dc && chompKeep)
        dc = dc.replace(/^\n+/, "");
      if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
          lines.push("");
        lines.push(stringifyComment.indentComment(commentString(dc), ""));
      }
    }
    return lines.join(`
`) + `
`;
  }
  exports.stringifyDocument = stringifyDocument;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS(function(exports) {
  var Alias = require_Alias();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var toJS = require_toJS();
  var Schema = require_Schema();
  var stringifyDocument = require_stringifyDocument();
  var anchors = require_anchors();
  var applyReviver = require_applyReviver();
  var createNode = require_createNode();
  var directives = require_directives();

  class Document {
    constructor(value, replacer, options) {
      this.commentBefore = null;
      this.comment = null;
      this.errors = [];
      this.warnings = [];
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const opt = Object.assign({
        intAsBigInt: false,
        keepSourceTokens: false,
        logLevel: "warn",
        prettyErrors: true,
        strict: true,
        stringKeys: false,
        uniqueKeys: true,
        version: "1.2"
      }, options);
      this.options = opt;
      let { version } = opt;
      if (options?._directives) {
        this.directives = options._directives.atDocument();
        if (this.directives.yaml.explicit)
          version = this.directives.yaml.version;
      } else
        this.directives = new directives.Directives({ version });
      this.setSchema(version, options);
      this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
    }
    clone() {
      const copy = Object.create(Document.prototype, {
        [identity.NODE_TYPE]: { value: identity.DOC }
      });
      copy.commentBefore = this.commentBefore;
      copy.comment = this.comment;
      copy.errors = this.errors.slice();
      copy.warnings = this.warnings.slice();
      copy.options = Object.assign({}, this.options);
      if (this.directives)
        copy.directives = this.directives.clone();
      copy.schema = this.schema.clone();
      copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    add(value) {
      if (assertCollection(this.contents))
        this.contents.add(value);
    }
    addIn(path, value) {
      if (assertCollection(this.contents))
        this.contents.addIn(path, value);
    }
    createAlias(node, name) {
      if (!node.anchor) {
        const prev = anchors.anchorNames(this);
        node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
      }
      return new Alias.Alias(node.anchor);
    }
    createNode(value, replacer, options) {
      let _replacer = undefined;
      if (typeof replacer === "function") {
        value = replacer.call({ "": value }, "", value);
        _replacer = replacer;
      } else if (Array.isArray(replacer)) {
        const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
        const asStr = replacer.filter(keyToStr).map(String);
        if (asStr.length > 0)
          replacer = replacer.concat(asStr);
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
      const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
      const ctx = {
        aliasDuplicateObjects: aliasDuplicateObjects ?? true,
        keepUndefined: keepUndefined ?? false,
        onAnchor,
        onTagObj,
        replacer: _replacer,
        schema: this.schema,
        sourceObjects
      };
      const node = createNode.createNode(value, tag, ctx);
      if (flow && identity.isCollection(node))
        node.flow = true;
      setAnchors();
      return node;
    }
    createPair(key, value, options = {}) {
      const k = this.createNode(key, null, options);
      const v = this.createNode(value, null, options);
      return new Pair.Pair(k, v);
    }
    delete(key) {
      return assertCollection(this.contents) ? this.contents.delete(key) : false;
    }
    deleteIn(path) {
      if (Collection.isEmptyPath(path)) {
        if (this.contents == null)
          return false;
        this.contents = null;
        return true;
      }
      return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
    }
    get(key, keepScalar) {
      return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
    }
    getIn(path, keepScalar) {
      if (Collection.isEmptyPath(path))
        return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
      return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
    }
    has(key) {
      return identity.isCollection(this.contents) ? this.contents.has(key) : false;
    }
    hasIn(path) {
      if (Collection.isEmptyPath(path))
        return this.contents !== undefined;
      return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
    }
    set(key, value) {
      if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, [key], value);
      } else if (assertCollection(this.contents)) {
        this.contents.set(key, value);
      }
    }
    setIn(path, value) {
      if (Collection.isEmptyPath(path)) {
        this.contents = value;
      } else if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
      } else if (assertCollection(this.contents)) {
        this.contents.setIn(path, value);
      }
    }
    setSchema(version, options = {}) {
      if (typeof version === "number")
        version = String(version);
      let opt;
      switch (version) {
        case "1.1":
          if (this.directives)
            this.directives.yaml.version = "1.1";
          else
            this.directives = new directives.Directives({ version: "1.1" });
          opt = { resolveKnownTags: false, schema: "yaml-1.1" };
          break;
        case "1.2":
        case "next":
          if (this.directives)
            this.directives.yaml.version = version;
          else
            this.directives = new directives.Directives({ version });
          opt = { resolveKnownTags: true, schema: "core" };
          break;
        case null:
          if (this.directives)
            delete this.directives;
          opt = null;
          break;
        default: {
          const sv = JSON.stringify(version);
          throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
        }
      }
      if (options.schema instanceof Object)
        this.schema = options.schema;
      else if (opt)
        this.schema = new Schema.Schema(Object.assign(opt, options));
      else
        throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
    }
    toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      const ctx = {
        anchors: new Map,
        doc: this,
        keep: !json,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res } of ctx.anchors.values())
          onAnchor(res, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
    toJSON(jsonArg, onAnchor) {
      return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
    }
    toString(options = {}) {
      if (this.errors.length > 0)
        throw new Error("Document with errors cannot be stringified");
      if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
        const s = JSON.stringify(options.indent);
        throw new Error(`"indent" option must be a positive integer, not ${s}`);
      }
      return stringifyDocument.stringifyDocument(this, options);
    }
  }
  function assertCollection(contents) {
    if (identity.isCollection(contents))
      return true;
    throw new Error("Expected a YAML collection as document contents");
  }
  exports.Document = Document;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/errors.js
var require_errors = __commonJS(function(exports) {
  class YAMLError extends Error {
    constructor(name, pos, code, message) {
      super();
      this.name = name;
      this.code = code;
      this.message = message;
      this.pos = pos;
    }
  }

  class YAMLParseError extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLParseError", pos, code, message);
    }
  }

  class YAMLWarning extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLWarning", pos, code, message);
    }
  }
  var prettifyError = (src, lc) => (error) => {
    if (error.pos[0] === -1)
      return;
    error.linePos = error.pos.map((pos) => lc.linePos(pos));
    const { line, col } = error.linePos[0];
    error.message += ` at line ${line}, column ${col}`;
    let ci = col - 1;
    let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
    if (ci >= 60 && lineStr.length > 80) {
      const trimStart = Math.min(ci - 39, lineStr.length - 79);
      lineStr = "\u2026" + lineStr.substring(trimStart);
      ci -= trimStart - 1;
    }
    if (lineStr.length > 80)
      lineStr = lineStr.substring(0, 79) + "\u2026";
    if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
      let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
      if (prev.length > 80)
        prev = prev.substring(0, 79) + `\u2026
`;
      lineStr = prev + lineStr;
    }
    if (/[^ ]/.test(lineStr)) {
      let count = 1;
      const end = error.linePos[1];
      if (end?.line === line && end.col > col) {
        count = Math.max(1, Math.min(end.col - col, 80 - ci));
      }
      const pointer = " ".repeat(ci) + "^".repeat(count);
      error.message += `:

${lineStr}
${pointer}
`;
    }
  };
  exports.YAMLError = YAMLError;
  exports.YAMLParseError = YAMLParseError;
  exports.YAMLWarning = YAMLWarning;
  exports.prettifyError = prettifyError;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS(function(exports) {
  function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
    let spaceBefore = false;
    let atNewline = startOnNewline;
    let hasSpace = startOnNewline;
    let comment = "";
    let commentSep = "";
    let hasNewline = false;
    let reqSpace = false;
    let tab = null;
    let anchor = null;
    let tag = null;
    let newlineAfterProp = null;
    let comma = null;
    let found = null;
    let start = null;
    for (const token of tokens) {
      if (reqSpace) {
        if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
          onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
        reqSpace = false;
      }
      if (tab) {
        if (atNewline && token.type !== "comment" && token.type !== "newline") {
          onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
        }
        tab = null;
      }
      switch (token.type) {
        case "space":
          if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
            tab = token;
          }
          hasSpace = true;
          break;
        case "comment": {
          if (!hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = token.source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += commentSep + cb;
          commentSep = "";
          atNewline = false;
          break;
        }
        case "newline":
          if (atNewline) {
            if (comment)
              comment += token.source;
            else if (!found || indicator !== "seq-item-ind")
              spaceBefore = true;
          } else
            commentSep += token.source;
          atNewline = true;
          hasNewline = true;
          if (anchor || tag)
            newlineAfterProp = token;
          hasSpace = true;
          break;
        case "anchor":
          if (anchor)
            onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
          if (token.source.endsWith(":"))
            onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
          anchor = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        case "tag": {
          if (tag)
            onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
          tag = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        }
        case indicator:
          if (anchor || tag)
            onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
          if (found)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
          found = token;
          atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
          hasSpace = false;
          break;
        case "comma":
          if (flow) {
            if (comma)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
            comma = token;
            atNewline = false;
            hasSpace = false;
            break;
          }
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
          atNewline = false;
          hasSpace = false;
      }
    }
    const last = tokens[tokens.length - 1];
    const end = last ? last.offset + last.source.length : offset;
    if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
      onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
    }
    if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
      onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
    return {
      comma,
      found,
      spaceBefore,
      comment,
      hasNewline,
      anchor,
      tag,
      newlineAfterProp,
      end,
      start: start ?? end
    };
  }
  exports.resolveProps = resolveProps;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS(function(exports) {
  function containsNewline(key) {
    if (!key)
      return null;
    switch (key.type) {
      case "alias":
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        if (key.source.includes(`
`))
          return true;
        if (key.end) {
          for (const st of key.end)
            if (st.type === "newline")
              return true;
        }
        return false;
      case "flow-collection":
        for (const it of key.items) {
          for (const st of it.start)
            if (st.type === "newline")
              return true;
          if (it.sep) {
            for (const st of it.sep)
              if (st.type === "newline")
                return true;
          }
          if (containsNewline(it.key) || containsNewline(it.value))
            return true;
        }
        return false;
      default:
        return true;
    }
  }
  exports.containsNewline = containsNewline;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS(function(exports) {
  var utilContainsNewline = require_util_contains_newline();
  function flowIndentCheck(indent, fc, onError) {
    if (fc?.type === "flow-collection") {
      const end = fc.end[0];
      if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
        const msg = "Flow end indicator should be more indented than parent";
        onError(end, "BAD_INDENT", msg, true);
      }
    }
  }
  exports.flowIndentCheck = flowIndentCheck;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS(function(exports) {
  var identity = require_identity();
  function mapIncludes(ctx, items, search) {
    const { uniqueKeys } = ctx.options;
    if (uniqueKeys === false)
      return false;
    const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
    return items.some((pair) => isEqual(pair.key, search));
  }
  exports.mapIncludes = mapIncludes;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS(function(exports) {
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  var utilMapIncludes = require_util_map_includes();
  var startColMsg = "All mapping items must start at the same column";
  function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
    const map = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    let offset = bm.offset;
    let commentEnd = null;
    for (const collItem of bm.items) {
      const { start, key, sep, value } = collItem;
      const keyProps = resolveProps.resolveProps(start, {
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: bm.indent,
        startOnNewline: true
      });
      const implicitKey = !keyProps.found;
      if (implicitKey) {
        if (key) {
          if (key.type === "block-seq")
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
          else if ("indent" in key && key.indent !== bm.indent)
            onError(offset, "BAD_INDENT", startColMsg);
        }
        if (!keyProps.anchor && !keyProps.tag && !sep) {
          commentEnd = keyProps.end;
          if (keyProps.comment) {
            if (map.comment)
              map.comment += `
` + keyProps.comment;
            else
              map.comment = keyProps.comment;
          }
          continue;
        }
        if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
          onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
        }
      } else if (keyProps.found?.indent !== bm.indent) {
        onError(offset, "BAD_INDENT", startColMsg);
      }
      ctx.atKey = true;
      const keyStart = keyProps.end;
      const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
      ctx.atKey = false;
      if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
        onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
      const valueProps = resolveProps.resolveProps(sep ?? [], {
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: bm.indent,
        startOnNewline: !key || key.type === "block-scalar"
      });
      offset = valueProps.end;
      if (valueProps.found) {
        if (implicitKey) {
          if (value?.type === "block-map" && !valueProps.hasNewline)
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
          if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
            onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
        offset = valueNode.range[2];
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      } else {
        if (implicitKey)
          onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
        if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      }
    }
    if (commentEnd && commentEnd < offset)
      onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
    map.range = [bm.offset, offset, commentEnd ?? offset];
    return map;
  }
  exports.resolveBlockMap = resolveBlockMap;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS(function(exports) {
  var YAMLSeq = require_YAMLSeq();
  var resolveProps = require_resolve_props();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
    const seq = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = bs.offset;
    let commentEnd = null;
    for (const { start, value } of bs.items) {
      const props = resolveProps.resolveProps(start, {
        indicator: "seq-item-ind",
        next: value,
        offset,
        onError,
        parentIndent: bs.indent,
        startOnNewline: true
      });
      if (!props.found) {
        if (props.anchor || props.tag || value) {
          if (value?.type === "block-seq")
            onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
          else
            onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
        } else {
          commentEnd = props.end;
          if (props.comment)
            seq.comment = props.comment;
          continue;
        }
      }
      const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
      offset = node.range[2];
      seq.items.push(node);
    }
    seq.range = [bs.offset, offset, commentEnd ?? offset];
    return seq;
  }
  exports.resolveBlockSeq = resolveBlockSeq;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS(function(exports) {
  function resolveEnd(end, offset, reqSpace, onError) {
    let comment = "";
    if (end) {
      let hasSpace = false;
      let sep = "";
      for (const token of end) {
        const { source, type } = token;
        switch (type) {
          case "space":
            hasSpace = true;
            break;
          case "comment": {
            if (reqSpace && !hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += sep + cb;
            sep = "";
            break;
          }
          case "newline":
            if (comment)
              sep += source;
            hasSpace = true;
            break;
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
        }
        offset += source.length;
      }
    }
    return { comment, offset };
  }
  exports.resolveEnd = resolveEnd;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS(function(exports) {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilMapIncludes = require_util_map_includes();
  var blockMsg = "Block collections are not allowed within flow collections";
  var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
  function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
    const isMap = fc.start.source === "{";
    const fcName = isMap ? "flow map" : "flow sequence";
    const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
    const coll = new NodeClass(ctx.schema);
    coll.flow = true;
    const atRoot = ctx.atRoot;
    if (atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = fc.offset + fc.start.source.length;
    for (let i = 0;i < fc.items.length; ++i) {
      const collItem = fc.items[i];
      const { start, key, sep, value } = collItem;
      const props = resolveProps.resolveProps(start, {
        flow: fcName,
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (!props.found) {
        if (!props.anchor && !props.tag && !sep && !value) {
          if (i === 0 && props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
          else if (i < fc.items.length - 1)
            onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
          if (props.comment) {
            if (coll.comment)
              coll.comment += `
` + props.comment;
            else
              coll.comment = props.comment;
          }
          offset = props.end;
          continue;
        }
        if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
          onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
      }
      if (i === 0) {
        if (props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
      } else {
        if (!props.comma)
          onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
        if (props.comment) {
          let prevItemComment = "";
          loop:
            for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
          if (prevItemComment) {
            let prev = coll.items[coll.items.length - 1];
            if (identity.isPair(prev))
              prev = prev.value ?? prev.key;
            if (prev.comment)
              prev.comment += `
` + prevItemComment;
            else
              prev.comment = prevItemComment;
            props.comment = props.comment.substring(prevItemComment.length + 1);
          }
        }
      }
      if (!isMap && !sep && !props.found) {
        const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
        coll.items.push(valueNode);
        offset = valueNode.range[2];
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else {
        ctx.atKey = true;
        const keyStart = props.end;
        const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
        if (isBlock(key))
          onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
        ctx.atKey = false;
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          flow: fcName,
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (valueProps.found) {
          if (!isMap && !props.found && ctx.options.strict) {
            if (sep)
              for (const st of sep) {
                if (st === valueProps.found)
                  break;
                if (st.type === "newline") {
                  onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                  break;
                }
              }
            if (props.start < valueProps.found.offset - 1024)
              onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
          }
        } else if (value) {
          if ("source" in value && value.source?.[0] === ":")
            onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
          else
            onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
        if (valueNode) {
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        if (isMap) {
          const map = coll;
          if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
            onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
          map.items.push(pair);
        } else {
          const map = new YAMLMap.YAMLMap(ctx.schema);
          map.flow = true;
          map.items.push(pair);
          const endRange = (valueNode ?? keyNode).range;
          map.range = [keyNode.range[0], endRange[1], endRange[2]];
          coll.items.push(map);
        }
        offset = valueNode ? valueNode.range[2] : valueProps.end;
      }
    }
    const expectedEnd = isMap ? "}" : "]";
    const [ce, ...ee] = fc.end;
    let cePos = offset;
    if (ce?.source === expectedEnd)
      cePos = ce.offset + ce.source.length;
    else {
      const name = fcName[0].toUpperCase() + fcName.substring(1);
      const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
      onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
      if (ce && ce.source.length !== 1)
        ee.unshift(ce);
    }
    if (ee.length > 0) {
      const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
      if (end.comment) {
        if (coll.comment)
          coll.comment += `
` + end.comment;
        else
          coll.comment = end.comment;
      }
      coll.range = [fc.offset, cePos, end.offset];
    } else {
      coll.range = [fc.offset, cePos, cePos];
    }
    return coll;
  }
  exports.resolveFlowCollection = resolveFlowCollection;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS(function(exports) {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveBlockMap = require_resolve_block_map();
  var resolveBlockSeq = require_resolve_block_seq();
  var resolveFlowCollection = require_resolve_flow_collection();
  function resolveCollection(CN, ctx, token, onError, tagName, tag) {
    const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
    const Coll = coll.constructor;
    if (tagName === "!" || tagName === Coll.tagName) {
      coll.tag = Coll.tagName;
      return coll;
    }
    if (tagName)
      coll.tag = tagName;
    return coll;
  }
  function composeCollection(CN, ctx, token, props, onError) {
    const tagToken = props.tag;
    const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
    if (token.type === "block-seq") {
      const { anchor, newlineAfterProp: nl } = props;
      const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
      if (lastProp && (!nl || nl.offset < lastProp.offset)) {
        const message = "Missing newline after block sequence props";
        onError(lastProp, "MISSING_CHAR", message);
      }
    }
    const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
    if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
    let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
    if (!tag) {
      const kt = ctx.schema.knownTags[tagName];
      if (kt?.collection === expType) {
        ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
        tag = kt;
      } else {
        if (kt) {
          onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
        } else {
          onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
        }
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
    }
    const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
    const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
    const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
    node.range = coll.range;
    node.tag = tagName;
    if (tag?.format)
      node.format = tag.format;
    return node;
  }
  exports.composeCollection = composeCollection;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  function resolveBlockScalar(ctx, scalar, onError) {
    const start = scalar.offset;
    const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
    if (!header)
      return { value: "", type: null, comment: "", range: [start, start, start] };
    const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
    const lines = scalar.source ? splitLines(scalar.source) : [];
    let chompStart = lines.length;
    for (let i = lines.length - 1;i >= 0; --i) {
      const content = lines[i][1];
      if (content === "" || content === "\r")
        chompStart = i;
      else
        break;
    }
    if (chompStart === 0) {
      const value = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
      let end = start + header.length;
      if (scalar.source)
        end += scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    let trimIndent = scalar.indent + header.indent;
    let offset = scalar.offset + header.length;
    let contentStart = 0;
    for (let i = 0;i < chompStart; ++i) {
      const [indent, content] = lines[i];
      if (content === "" || content === "\r") {
        if (header.indent === 0 && indent.length > trimIndent)
          trimIndent = indent.length;
      } else {
        if (indent.length < trimIndent) {
          const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
          onError(offset + indent.length, "MISSING_CHAR", message);
        }
        if (header.indent === 0)
          trimIndent = indent.length;
        contentStart = i;
        if (trimIndent === 0 && !ctx.atRoot) {
          const message = "Block scalar values in collections must be indented";
          onError(offset, "BAD_INDENT", message);
        }
        break;
      }
      offset += indent.length + content.length + 1;
    }
    for (let i = lines.length - 1;i >= chompStart; --i) {
      if (lines[i][0].length > trimIndent)
        chompStart = i + 1;
    }
    let value = "";
    let sep = "";
    let prevMoreIndented = false;
    for (let i = 0;i < contentStart; ++i)
      value += lines[i][0].slice(trimIndent) + `
`;
    for (let i = contentStart;i < chompStart; ++i) {
      let [indent, content] = lines[i];
      offset += indent.length + content.length + 1;
      const crlf = content[content.length - 1] === "\r";
      if (crlf)
        content = content.slice(0, -1);
      if (content && indent.length < trimIndent) {
        const src = header.indent ? "explicit indentation indicator" : "first line";
        const message = `Block scalar lines must not be less indented than their ${src}`;
        onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
        indent = "";
      }
      if (type === Scalar.Scalar.BLOCK_LITERAL) {
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
      } else if (indent.length > trimIndent || content[0] === "\t") {
        if (sep === " ")
          sep = `
`;
        else if (!prevMoreIndented && sep === `
`)
          sep = `

`;
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
        prevMoreIndented = true;
      } else if (content === "") {
        if (sep === `
`)
          value += `
`;
        else
          sep = `
`;
      } else {
        value += sep + content;
        sep = " ";
        prevMoreIndented = false;
      }
    }
    switch (header.chomp) {
      case "-":
        break;
      case "+":
        for (let i = chompStart;i < lines.length; ++i)
          value += `
` + lines[i][0].slice(trimIndent);
        if (value[value.length - 1] !== `
`)
          value += `
`;
        break;
      default:
        value += `
`;
    }
    const end = start + header.length + scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  function parseBlockScalarHeader({ offset, props }, strict, onError) {
    if (props[0].type !== "block-scalar-header") {
      onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
      return null;
    }
    const { source } = props[0];
    const mode = source[0];
    let indent = 0;
    let chomp = "";
    let error = -1;
    for (let i = 1;i < source.length; ++i) {
      const ch = source[i];
      if (!chomp && (ch === "-" || ch === "+"))
        chomp = ch;
      else {
        const n = Number(ch);
        if (!indent && n)
          indent = n;
        else if (error === -1)
          error = offset + i;
      }
    }
    if (error !== -1)
      onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
    let hasSpace = false;
    let comment = "";
    let length = source.length;
    for (let i = 1;i < props.length; ++i) {
      const token = props[i];
      switch (token.type) {
        case "space":
          hasSpace = true;
        case "newline":
          length += token.source.length;
          break;
        case "comment":
          if (strict && !hasSpace) {
            const message = "Comments must be separated from other tokens by white space characters";
            onError(token, "MISSING_CHAR", message);
          }
          length += token.source.length;
          comment = token.source.substring(1);
          break;
        case "error":
          onError(token, "UNEXPECTED_TOKEN", token.message);
          length += token.source.length;
          break;
        default: {
          const message = `Unexpected token in block scalar header: ${token.type}`;
          onError(token, "UNEXPECTED_TOKEN", message);
          const ts = token.source;
          if (ts && typeof ts === "string")
            length += ts.length;
        }
      }
    }
    return { mode, indent, chomp, comment, length };
  }
  function splitLines(source) {
    const split = source.split(/\n( *)/);
    const first = split[0];
    const m = first.match(/^( *)/);
    const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
    const lines = [line0];
    for (let i = 1;i < split.length; i += 2)
      lines.push([split[i], split[i + 1]]);
    return lines;
  }
  exports.resolveBlockScalar = resolveBlockScalar;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS(function(exports) {
  var Scalar = require_Scalar();
  var resolveEnd = require_resolve_end();
  function resolveFlowScalar(scalar, strict, onError) {
    const { offset, type, source, end } = scalar;
    let _type;
    let value;
    const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
    switch (type) {
      case "scalar":
        _type = Scalar.Scalar.PLAIN;
        value = plainValue(source, _onError);
        break;
      case "single-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_SINGLE;
        value = singleQuotedValue(source, _onError);
        break;
      case "double-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_DOUBLE;
        value = doubleQuotedValue(source, _onError);
        break;
      default:
        onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
        return {
          value: "",
          type: null,
          comment: "",
          range: [offset, offset + source.length, offset + source.length]
        };
    }
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
    return {
      value,
      type: _type,
      comment: re.comment,
      range: [offset, valueEnd, re.offset]
    };
  }
  function plainValue(source, onError) {
    let badChar = "";
    switch (source[0]) {
      case "\t":
        badChar = "a tab character";
        break;
      case ",":
        badChar = "flow indicator character ,";
        break;
      case "%":
        badChar = "directive indicator character %";
        break;
      case "|":
      case ">": {
        badChar = `block scalar indicator ${source[0]}`;
        break;
      }
      case "@":
      case "`": {
        badChar = `reserved character ${source[0]}`;
        break;
      }
    }
    if (badChar)
      onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
    return unfoldLines(source);
  }
  function singleQuotedValue(source, onError) {
    if (source[source.length - 1] !== "'" || source.length === 1)
      onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
    return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
  }
  function unfoldLines(source) {
    const line = /(.*?)\r?\n/sy;
    let match = line.exec(source);
    if (!match)
      return source;
    let trimEnd, trimBoth;
    try {
      trimEnd = new RegExp("(?<![ \t])[ \t]+$");
      trimBoth = new RegExp("^[ \t]+|(?<![ \t])[ \t]+$", "g");
    } catch {
      trimEnd = /[ \t]+$/;
      trimBoth = /^[ \t]+|[ \t]+$/g;
    }
    let res = match[1].replace(trimEnd, "");
    let sep = " ";
    let pos = line.lastIndex;
    while (match = line.exec(source)) {
      const lm = match[1].replace(trimBoth, "");
      if (lm === "") {
        if (sep === `
`)
          res += sep;
        else
          sep = `
`;
      } else {
        res += sep + lm;
        sep = " ";
      }
      pos = line.lastIndex;
    }
    const last = /[ \t]*(.*)/sy;
    last.lastIndex = pos;
    match = last.exec(source);
    return res + sep + (match?.[1] ?? "");
  }
  function doubleQuotedValue(source, onError) {
    let res = "";
    for (let i = 1;i < source.length - 1; ++i) {
      const ch = source[i];
      if (ch === "\r" && source[i + 1] === `
`)
        continue;
      if (ch === `
`) {
        const { fold, offset } = foldNewline(source, i);
        res += fold;
        i = offset;
      } else if (ch === "\\") {
        let next = source[++i];
        const cc = escapeCodes[next];
        if (cc)
          res += cc;
        else if (next === `
`) {
          next = source[i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "\r" && source[i + 1] === `
`) {
          next = source[++i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "x" || next === "u" || next === "U") {
          const length = next === "x" ? 2 : next === "u" ? 4 : 8;
          res += parseCharCode(source, i + 1, length, onError);
          i += length;
        } else {
          const raw = source.substr(i - 1, 2);
          onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
          res += raw;
        }
      } else if (ch === " " || ch === "\t") {
        const wsStart = i;
        let next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
        if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
          res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
      } else {
        res += ch;
      }
    }
    if (source[source.length - 1] !== '"' || source.length === 1)
      onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
    return res;
  }
  function foldNewline(source, offset) {
    let fold = "";
    let ch = source[offset + 1];
    while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
      if (ch === "\r" && source[offset + 2] !== `
`)
        break;
      if (ch === `
`)
        fold += `
`;
      offset += 1;
      ch = source[offset + 1];
    }
    if (!fold)
      fold = " ";
    return { fold, offset };
  }
  var escapeCodes = {
    "0": "\x00",
    a: "\x07",
    b: "\b",
    e: "\x1B",
    f: "\f",
    n: `
`,
    r: "\r",
    t: "\t",
    v: "\v",
    N: "\x85",
    _: "\xA0",
    L: "\u2028",
    P: "\u2029",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "\t": "\t"
  };
  function parseCharCode(source, offset, length, onError) {
    const cc = source.substr(offset, length);
    const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
    const code = ok ? parseInt(cc, 16) : NaN;
    try {
      return String.fromCodePoint(code);
    } catch {
      const raw = source.substr(offset - 2, length + 2);
      onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
      return raw;
    }
  }
  exports.resolveFlowScalar = resolveFlowScalar;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS(function(exports) {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  function composeScalar(ctx, token, tagToken, onError) {
    const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
    const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
    let tag;
    if (ctx.options.stringKeys && ctx.atKey) {
      tag = ctx.schema[identity.SCALAR];
    } else if (tagName)
      tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
    else if (token.type === "scalar")
      tag = findScalarTagByTest(ctx, value, token, onError);
    else
      tag = ctx.schema[identity.SCALAR];
    let scalar;
    try {
      const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
      scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
      scalar = new Scalar.Scalar(value);
    }
    scalar.range = range;
    scalar.source = value;
    if (type)
      scalar.type = type;
    if (tagName)
      scalar.tag = tagName;
    if (tag.format)
      scalar.format = tag.format;
    if (comment)
      scalar.comment = comment;
    return scalar;
  }
  function findScalarTagByName(schema, value, tagName, tagToken, onError) {
    if (tagName === "!")
      return schema[identity.SCALAR];
    const matchWithTest = [];
    for (const tag of schema.tags) {
      if (!tag.collection && tag.tag === tagName) {
        if (tag.default && tag.test)
          matchWithTest.push(tag);
        else
          return tag;
      }
    }
    for (const tag of matchWithTest)
      if (tag.test?.test(value))
        return tag;
    const kt = schema.knownTags[tagName];
    if (kt && !kt.collection) {
      schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
      return kt;
    }
    onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
    return schema[identity.SCALAR];
  }
  function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
    const tag = schema.tags.find((tag) => (tag.default === true || atKey && tag.default === "key") && tag.test?.test(value)) || schema[identity.SCALAR];
    if (schema.compat) {
      const compat = schema.compat.find((tag) => tag.default && tag.test?.test(value)) ?? schema[identity.SCALAR];
      if (tag.tag !== compat.tag) {
        const ts = directives.tagString(tag.tag);
        const cs = directives.tagString(compat.tag);
        const msg = `Value may be parsed as either ${ts} or ${cs}`;
        onError(token, "TAG_RESOLVE_FAILED", msg, true);
      }
    }
    return tag;
  }
  exports.composeScalar = composeScalar;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS(function(exports) {
  function emptyScalarPosition(offset, before, pos) {
    if (before) {
      pos ?? (pos = before.length);
      for (let i = pos - 1;i >= 0; --i) {
        let st = before[i];
        switch (st.type) {
          case "space":
          case "comment":
          case "newline":
            offset -= st.source.length;
            continue;
        }
        st = before[++i];
        while (st?.type === "space") {
          offset += st.source.length;
          st = before[++i];
        }
        break;
      }
    }
    return offset;
  }
  exports.emptyScalarPosition = emptyScalarPosition;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS(function(exports) {
  var Alias = require_Alias();
  var identity = require_identity();
  var composeCollection = require_compose_collection();
  var composeScalar = require_compose_scalar();
  var resolveEnd = require_resolve_end();
  var utilEmptyScalarPosition = require_util_empty_scalar_position();
  var CN = { composeNode, composeEmptyNode };
  function composeNode(ctx, token, props, onError) {
    const atKey = ctx.atKey;
    const { spaceBefore, comment, anchor, tag } = props;
    let node;
    let isSrcToken = true;
    switch (token.type) {
      case "alias":
        node = composeAlias(ctx, token, onError);
        if (anchor || tag)
          onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
        break;
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "block-scalar":
        node = composeScalar.composeScalar(ctx, token, tag, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      case "block-map":
      case "block-seq":
      case "flow-collection":
        try {
          node = composeCollection.composeCollection(CN, ctx, token, props, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onError(token, "RESOURCE_EXHAUSTION", message);
        }
        break;
      default: {
        const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
        onError(token, "UNEXPECTED_TOKEN", message);
        isSrcToken = false;
      }
    }
    node ?? (node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError));
    if (anchor && node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
      const msg = "With stringKeys, all keys must be strings";
      onError(tag ?? token, "NON_STRING_KEY", msg);
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      if (token.type === "scalar" && token.source === "")
        node.comment = comment;
      else
        node.commentBefore = comment;
    }
    if (ctx.options.keepSourceTokens && isSrcToken)
      node.srcToken = token;
    return node;
  }
  function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
    const token = {
      type: "scalar",
      offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
      indent: -1,
      source: ""
    };
    const node = composeScalar.composeScalar(ctx, token, tag, onError);
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      node.comment = comment;
      node.range[2] = end;
    }
    return node;
  }
  function composeAlias({ options }, { offset, source, end }, onError) {
    const alias = new Alias.Alias(source.substring(1));
    if (alias.source === "")
      onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
    if (alias.source.endsWith(":"))
      onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
    alias.range = [offset, valueEnd, re.offset];
    if (re.comment)
      alias.comment = re.comment;
    return alias;
  }
  exports.composeEmptyNode = composeEmptyNode;
  exports.composeNode = composeNode;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS(function(exports) {
  var Document = require_Document();
  var composeNode = require_compose_node();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  function composeDoc(options, directives, { offset, start, value, end }, onError) {
    const opts = Object.assign({ _directives: directives }, options);
    const doc = new Document.Document(undefined, opts);
    const ctx = {
      atKey: false,
      atRoot: true,
      directives: doc.directives,
      options: doc.options,
      schema: doc.schema
    };
    const props = resolveProps.resolveProps(start, {
      indicator: "doc-start",
      next: value ?? end?.[0],
      offset,
      onError,
      parentIndent: 0,
      startOnNewline: true
    });
    if (props.found) {
      doc.directives.docStart = true;
      if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
        onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
    }
    doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
    const contentEnd = doc.contents.range[2];
    const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
    if (re.comment)
      doc.comment = re.comment;
    doc.range = [offset, contentEnd, re.offset];
    return doc;
  }
  exports.composeDoc = composeDoc;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS(function(exports) {
  var node_process = __require("process");
  var directives = require_directives();
  var Document = require_Document();
  var errors = require_errors();
  var identity = require_identity();
  var composeDoc = require_compose_doc();
  var resolveEnd = require_resolve_end();
  function getErrorPos(src) {
    if (typeof src === "number")
      return [src, src + 1];
    if (Array.isArray(src))
      return src.length === 2 ? src : [src[0], src[1]];
    const { offset, source } = src;
    return [offset, offset + (typeof source === "string" ? source.length : 1)];
  }
  function parsePrelude(prelude) {
    let comment = "";
    let atComment = false;
    let afterEmptyLine = false;
    for (let i = 0;i < prelude.length; ++i) {
      const source = prelude[i];
      switch (source[0]) {
        case "#":
          comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
          atComment = true;
          afterEmptyLine = false;
          break;
        case "%":
          if (prelude[i + 1]?.[0] !== "#")
            i += 1;
          atComment = false;
          break;
        default:
          if (!atComment)
            afterEmptyLine = true;
          atComment = false;
      }
    }
    return { comment, afterEmptyLine };
  }

  class Composer {
    constructor(options = {}) {
      this.doc = null;
      this.atDirectives = false;
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
      this.onError = (source, code, message, warning) => {
        const pos = getErrorPos(source);
        if (warning)
          this.warnings.push(new errors.YAMLWarning(pos, code, message));
        else
          this.errors.push(new errors.YAMLParseError(pos, code, message));
      };
      this.directives = new directives.Directives({ version: options.version || "1.2" });
      this.options = options;
    }
    decorate(doc, afterDoc) {
      const { comment, afterEmptyLine } = parsePrelude(this.prelude);
      if (comment) {
        const dc = doc.contents;
        if (afterDoc) {
          doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
        } else if (afterEmptyLine || doc.directives.docStart || !dc) {
          doc.commentBefore = comment;
        } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
          let it = dc.items[0];
          if (identity.isPair(it))
            it = it.key;
          const cb = it.commentBefore;
          it.commentBefore = cb ? `${comment}
${cb}` : comment;
        } else {
          const cb = dc.commentBefore;
          dc.commentBefore = cb ? `${comment}
${cb}` : comment;
        }
      }
      if (afterDoc) {
        for (let i = 0;i < this.errors.length; ++i)
          doc.errors.push(this.errors[i]);
        for (let i = 0;i < this.warnings.length; ++i)
          doc.warnings.push(this.warnings[i]);
      } else {
        doc.errors = this.errors;
        doc.warnings = this.warnings;
      }
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
    }
    streamInfo() {
      return {
        comment: parsePrelude(this.prelude).comment,
        directives: this.directives,
        errors: this.errors,
        warnings: this.warnings
      };
    }
    *compose(tokens, forceDoc = false, endOffset = -1) {
      for (const token of tokens)
        yield* this.next(token);
      yield* this.end(forceDoc, endOffset);
    }
    *next(token) {
      if (node_process.env.LOG_STREAM)
        console.dir(token, { depth: null });
      switch (token.type) {
        case "directive":
          this.directives.add(token.source, (offset, message, warning) => {
            const pos = getErrorPos(token);
            pos[0] += offset;
            this.onError(pos, "BAD_DIRECTIVE", message, warning);
          });
          this.prelude.push(token.source);
          this.atDirectives = true;
          break;
        case "document": {
          const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
          if (this.atDirectives && !doc.directives.docStart)
            this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
          this.decorate(doc, false);
          if (this.doc)
            yield this.doc;
          this.doc = doc;
          this.atDirectives = false;
          break;
        }
        case "byte-order-mark":
        case "space":
          break;
        case "comment":
        case "newline":
          this.prelude.push(token.source);
          break;
        case "error": {
          const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
          const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
          if (this.atDirectives || !this.doc)
            this.errors.push(error);
          else
            this.doc.errors.push(error);
          break;
        }
        case "doc-end": {
          if (!this.doc) {
            const msg = "Unexpected doc-end without preceding document";
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
            break;
          }
          this.doc.directives.docEnd = true;
          const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
          this.decorate(this.doc, true);
          if (end.comment) {
            const dc = this.doc.comment;
            this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
          }
          this.doc.range[2] = end.offset;
          break;
        }
        default:
          this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
      }
    }
    *end(forceDoc = false, endOffset = -1) {
      if (this.doc) {
        this.decorate(this.doc, true);
        yield this.doc;
        this.doc = null;
      } else if (forceDoc) {
        const opts = Object.assign({ _directives: this.directives }, this.options);
        const doc = new Document.Document(undefined, opts);
        if (this.atDirectives)
          this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
        doc.range = [0, endOffset, endOffset];
        this.decorate(doc, false);
        yield doc;
      }
    }
  }
  exports.Composer = Composer;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS(function(exports) {
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  var errors = require_errors();
  var stringifyString = require_stringifyString();
  function resolveAsScalar(token, strict = true, onError) {
    if (token) {
      const _onError = (pos, code, message) => {
        const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
        if (onError)
          onError(offset, code, message);
        else
          throw new errors.YAMLParseError([offset, offset + 1], code, message);
      };
      switch (token.type) {
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
        case "block-scalar":
          return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
      }
    }
    return null;
  }
  function createScalarToken(value, context) {
    const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey,
      indent: indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    const end = context.end ?? [
      { type: "newline", offset: -1, indent, source: `
` }
    ];
    switch (source[0]) {
      case "|":
      case ">": {
        const he = source.indexOf(`
`);
        const head = source.substring(0, he);
        const body = source.substring(he + 1) + `
`;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, end))
          props.push({ type: "newline", offset: -1, indent, source: `
` });
        return { type: "block-scalar", offset, indent, props, source: body };
      }
      case '"':
        return { type: "double-quoted-scalar", offset, indent, source, end };
      case "'":
        return { type: "single-quoted-scalar", offset, indent, source, end };
      default:
        return { type: "scalar", offset, indent, source, end };
    }
  }
  function setScalarValue(token, value, context = {}) {
    let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
    let indent = "indent" in token ? token.indent : null;
    if (afterKey && typeof indent === "number")
      indent += 2;
    if (!type)
      switch (token.type) {
        case "single-quoted-scalar":
          type = "QUOTE_SINGLE";
          break;
        case "double-quoted-scalar":
          type = "QUOTE_DOUBLE";
          break;
        case "block-scalar": {
          const header = token.props[0];
          if (header.type !== "block-scalar-header")
            throw new Error("Invalid block scalar header");
          type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
          break;
        }
        default:
          type = "PLAIN";
      }
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey: implicitKey || indent === null,
      indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    switch (source[0]) {
      case "|":
      case ">":
        setBlockScalarValue(token, source);
        break;
      case '"':
        setFlowScalarValue(token, source, "double-quoted-scalar");
        break;
      case "'":
        setFlowScalarValue(token, source, "single-quoted-scalar");
        break;
      default:
        setFlowScalarValue(token, source, "scalar");
    }
  }
  function setBlockScalarValue(token, source) {
    const he = source.indexOf(`
`);
    const head = source.substring(0, he);
    const body = source.substring(he + 1) + `
`;
    if (token.type === "block-scalar") {
      const header = token.props[0];
      if (header.type !== "block-scalar-header")
        throw new Error("Invalid block scalar header");
      header.source = head;
      token.source = body;
    } else {
      const { offset } = token;
      const indent = "indent" in token ? token.indent : -1;
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, "end" in token ? token.end : undefined))
        props.push({ type: "newline", offset: -1, indent, source: `
` });
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type: "block-scalar", indent, props, source: body });
    }
  }
  function addEndtoBlockProps(props, end) {
    if (end)
      for (const st of end)
        switch (st.type) {
          case "space":
          case "comment":
            props.push(st);
            break;
          case "newline":
            props.push(st);
            return true;
        }
    return false;
  }
  function setFlowScalarValue(token, source, type) {
    switch (token.type) {
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        token.type = type;
        token.source = source;
        break;
      case "block-scalar": {
        const end = token.props.slice(1);
        let oa = source.length;
        if (token.props[0].type === "block-scalar-header")
          oa -= token.props[0].source.length;
        for (const tok of end)
          tok.offset += oa;
        delete token.props;
        Object.assign(token, { type, source, end });
        break;
      }
      case "block-map":
      case "block-seq": {
        const offset = token.offset + source.length;
        const nl = { type: "newline", offset, indent: token.indent, source: `
` };
        delete token.items;
        Object.assign(token, { type, source, end: [nl] });
        break;
      }
      default: {
        const indent = "indent" in token ? token.indent : -1;
        const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type, indent, source, end });
      }
    }
  }
  exports.createScalarToken = createScalarToken;
  exports.resolveAsScalar = resolveAsScalar;
  exports.setScalarValue = setScalarValue;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS(function(exports) {
  var stringify = (cst) => ("type" in cst) ? stringifyToken(cst) : stringifyItem(cst);
  function stringifyToken(token) {
    switch (token.type) {
      case "block-scalar": {
        let res = "";
        for (const tok of token.props)
          res += stringifyToken(tok);
        return res + token.source;
      }
      case "block-map":
      case "block-seq": {
        let res = "";
        for (const item of token.items)
          res += stringifyItem(item);
        return res;
      }
      case "flow-collection": {
        let res = token.start.source;
        for (const item of token.items)
          res += stringifyItem(item);
        for (const st of token.end)
          res += st.source;
        return res;
      }
      case "document": {
        let res = stringifyItem(token);
        if (token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
      default: {
        let res = token.source;
        if ("end" in token && token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
    }
  }
  function stringifyItem({ start, key, sep, value }) {
    let res = "";
    for (const st of start)
      res += st.source;
    if (key)
      res += stringifyToken(key);
    if (sep)
      for (const st of sep)
        res += st.source;
    if (value)
      res += stringifyToken(value);
    return res;
  }
  exports.stringify = stringify;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS(function(exports) {
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove item");
  function visit(cst, visitor) {
    if ("type" in cst && cst.type === "document")
      cst = { start: cst.start, value: cst.value };
    _visit(Object.freeze([]), cst, visitor);
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  visit.itemAtPath = (cst, path) => {
    let item = cst;
    for (const [field, index] of path) {
      const tok = item?.[field];
      if (tok && "items" in tok) {
        item = tok.items[index];
      } else
        return;
    }
    return item;
  };
  visit.parentCollection = (cst, path) => {
    const parent = visit.itemAtPath(cst, path.slice(0, -1));
    const field = path[path.length - 1][0];
    const coll = parent?.[field];
    if (coll && "items" in coll)
      return coll;
    throw new Error("Parent collection not found");
  };
  function _visit(path, item, visitor) {
    let ctrl = visitor(item, path);
    if (typeof ctrl === "symbol")
      return ctrl;
    for (const field of ["key", "value"]) {
      const token = item[field];
      if (token && "items" in token) {
        for (let i = 0;i < token.items.length; ++i) {
          const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            token.items.splice(i, 1);
            i -= 1;
          }
        }
        if (typeof ctrl === "function" && field === "key")
          ctrl = ctrl(item, path);
      }
    }
    return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
  }
  exports.visit = visit;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS(function(exports) {
  var cstScalar = require_cst_scalar();
  var cstStringify = require_cst_stringify();
  var cstVisit = require_cst_visit();
  var BOM = "\uFEFF";
  var DOCUMENT = "\x02";
  var FLOW_END = "\x18";
  var SCALAR = "\x1F";
  var isCollection = (token) => !!token && ("items" in token);
  var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
  function prettyToken(token) {
    switch (token) {
      case BOM:
        return "<BOM>";
      case DOCUMENT:
        return "<DOC>";
      case FLOW_END:
        return "<FLOW_END>";
      case SCALAR:
        return "<SCALAR>";
      default:
        return JSON.stringify(token);
    }
  }
  function tokenType(source) {
    switch (source) {
      case BOM:
        return "byte-order-mark";
      case DOCUMENT:
        return "doc-mode";
      case FLOW_END:
        return "flow-error-end";
      case SCALAR:
        return "scalar";
      case "---":
        return "doc-start";
      case "...":
        return "doc-end";
      case "":
      case `
`:
      case `\r
`:
        return "newline";
      case "-":
        return "seq-item-ind";
      case "?":
        return "explicit-key-ind";
      case ":":
        return "map-value-ind";
      case "{":
        return "flow-map-start";
      case "}":
        return "flow-map-end";
      case "[":
        return "flow-seq-start";
      case "]":
        return "flow-seq-end";
      case ",":
        return "comma";
    }
    switch (source[0]) {
      case " ":
      case "\t":
        return "space";
      case "#":
        return "comment";
      case "%":
        return "directive-line";
      case "*":
        return "alias";
      case "&":
        return "anchor";
      case "!":
        return "tag";
      case "'":
        return "single-quoted-scalar";
      case '"':
        return "double-quoted-scalar";
      case "|":
      case ">":
        return "block-scalar-header";
    }
    return null;
  }
  exports.createScalarToken = cstScalar.createScalarToken;
  exports.resolveAsScalar = cstScalar.resolveAsScalar;
  exports.setScalarValue = cstScalar.setScalarValue;
  exports.stringify = cstStringify.stringify;
  exports.visit = cstVisit.visit;
  exports.BOM = BOM;
  exports.DOCUMENT = DOCUMENT;
  exports.FLOW_END = FLOW_END;
  exports.SCALAR = SCALAR;
  exports.isCollection = isCollection;
  exports.isScalar = isScalar;
  exports.prettyToken = prettyToken;
  exports.tokenType = tokenType;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS(function(exports) {
  var cst = require_cst();
  function isEmpty(ch) {
    switch (ch) {
      case undefined:
      case " ":
      case `
`:
      case "\r":
      case "\t":
        return true;
      default:
        return false;
    }
  }
  var hexDigits = new Set("0123456789ABCDEFabcdef");
  var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
  var flowIndicatorChars = new Set(",[]{}");
  var invalidAnchorChars = new Set(` ,[]{}
\r	`);
  var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

  class Lexer {
    constructor() {
      this.atEnd = false;
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      this.buffer = "";
      this.flowKey = false;
      this.flowLevel = 0;
      this.indentNext = 0;
      this.indentValue = 0;
      this.lineEndPos = null;
      this.next = null;
      this.pos = 0;
    }
    *lex(source, incomplete = false) {
      if (source) {
        if (typeof source !== "string")
          throw TypeError("source is not a string");
        this.buffer = this.buffer ? this.buffer + source : source;
        this.lineEndPos = null;
      }
      this.atEnd = !incomplete;
      let next = this.next ?? "stream";
      while (next && (incomplete || this.hasChars(1)))
        next = yield* this.parseNext(next);
    }
    atLineEnd() {
      let i = this.pos;
      let ch = this.buffer[i];
      while (ch === " " || ch === "\t")
        ch = this.buffer[++i];
      if (!ch || ch === "#" || ch === `
`)
        return true;
      if (ch === "\r")
        return this.buffer[i + 1] === `
`;
      return false;
    }
    charAt(n) {
      return this.buffer[this.pos + n];
    }
    continueScalar(offset) {
      let ch = this.buffer[offset];
      if (this.indentNext > 0) {
        let indent = 0;
        while (ch === " ")
          ch = this.buffer[++indent + offset];
        if (ch === "\r") {
          const next = this.buffer[indent + offset + 1];
          if (next === `
` || !next && !this.atEnd)
            return offset + indent + 1;
        }
        return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
      }
      if (ch === "-" || ch === ".") {
        const dt = this.buffer.substr(offset, 3);
        if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
          return -1;
      }
      return offset;
    }
    getLine() {
      let end = this.lineEndPos;
      if (typeof end !== "number" || end !== -1 && end < this.pos) {
        end = this.buffer.indexOf(`
`, this.pos);
        this.lineEndPos = end;
      }
      if (end === -1)
        return this.atEnd ? this.buffer.substring(this.pos) : null;
      if (this.buffer[end - 1] === "\r")
        end -= 1;
      return this.buffer.substring(this.pos, end);
    }
    hasChars(n) {
      return this.pos + n <= this.buffer.length;
    }
    setNext(state) {
      this.buffer = this.buffer.substring(this.pos);
      this.pos = 0;
      this.lineEndPos = null;
      this.next = state;
      return null;
    }
    peek(n) {
      return this.buffer.substr(this.pos, n);
    }
    *parseNext(next) {
      switch (next) {
        case "stream":
          return yield* this.parseStream();
        case "line-start":
          return yield* this.parseLineStart();
        case "block-start":
          return yield* this.parseBlockStart();
        case "doc":
          return yield* this.parseDocument();
        case "flow":
          return yield* this.parseFlowCollection();
        case "quoted-scalar":
          return yield* this.parseQuotedScalar();
        case "block-scalar":
          return yield* this.parseBlockScalar();
        case "plain-scalar":
          return yield* this.parsePlainScalar();
      }
    }
    *parseStream() {
      let line = this.getLine();
      if (line === null)
        return this.setNext("stream");
      if (line[0] === cst.BOM) {
        yield* this.pushCount(1);
        line = line.substring(1);
      }
      if (line[0] === "%") {
        let dirEnd = line.length;
        let cs = line.indexOf("#");
        while (cs !== -1) {
          const ch = line[cs - 1];
          if (ch === " " || ch === "\t") {
            dirEnd = cs - 1;
            break;
          } else {
            cs = line.indexOf("#", cs + 1);
          }
        }
        while (true) {
          const ch = line[dirEnd - 1];
          if (ch === " " || ch === "\t")
            dirEnd -= 1;
          else
            break;
        }
        const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
        yield* this.pushCount(line.length - n);
        this.pushNewline();
        return "stream";
      }
      if (this.atLineEnd()) {
        const sp = yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - sp);
        yield* this.pushNewline();
        return "stream";
      }
      yield cst.DOCUMENT;
      return yield* this.parseLineStart();
    }
    *parseLineStart() {
      const ch = this.charAt(0);
      if (!ch && !this.atEnd)
        return this.setNext("line-start");
      if (ch === "-" || ch === ".") {
        if (!this.atEnd && !this.hasChars(4))
          return this.setNext("line-start");
        const s = this.peek(3);
        if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
          yield* this.pushCount(3);
          this.indentValue = 0;
          this.indentNext = 0;
          return s === "---" ? "doc" : "stream";
        }
      }
      this.indentValue = yield* this.pushSpaces(false);
      if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
        this.indentNext = this.indentValue;
      return yield* this.parseBlockStart();
    }
    *parseBlockStart() {
      const [ch0, ch1] = this.peek(2);
      if (!ch1 && !this.atEnd)
        return this.setNext("block-start");
      if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
        const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
        this.indentNext = this.indentValue + 1;
        this.indentValue += n;
        return "block-start";
      }
      return "doc";
    }
    *parseDocument() {
      yield* this.pushSpaces(true);
      const line = this.getLine();
      if (line === null)
        return this.setNext("doc");
      let n = yield* this.pushIndicators();
      switch (line[n]) {
        case "#":
          yield* this.pushCount(line.length - n);
        case undefined:
          yield* this.pushNewline();
          return yield* this.parseLineStart();
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel = 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          return "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "doc";
        case '"':
        case "'":
          return yield* this.parseQuotedScalar();
        case "|":
        case ">":
          n += yield* this.parseBlockScalarHeader();
          n += yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - n);
          yield* this.pushNewline();
          return yield* this.parseBlockScalar();
        default:
          return yield* this.parsePlainScalar();
      }
    }
    *parseFlowCollection() {
      let nl, sp;
      let indent = -1;
      do {
        nl = yield* this.pushNewline();
        if (nl > 0) {
          sp = yield* this.pushSpaces(false);
          this.indentValue = indent = sp;
        } else {
          sp = 0;
        }
        sp += yield* this.pushSpaces(true);
      } while (nl + sp > 0);
      const line = this.getLine();
      if (line === null)
        return this.setNext("flow");
      if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
        const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
        if (!atFlowEndMarker) {
          this.flowLevel = 0;
          yield cst.FLOW_END;
          return yield* this.parseLineStart();
        }
      }
      let n = 0;
      while (line[n] === ",") {
        n += yield* this.pushCount(1);
        n += yield* this.pushSpaces(true);
        this.flowKey = false;
      }
      n += yield* this.pushIndicators();
      switch (line[n]) {
        case undefined:
          return "flow";
        case "#":
          yield* this.pushCount(line.length - n);
          return "flow";
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel += 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          this.flowKey = true;
          this.flowLevel -= 1;
          return this.flowLevel ? "flow" : "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "flow";
        case '"':
        case "'":
          this.flowKey = true;
          return yield* this.parseQuotedScalar();
        case ":": {
          const next = this.charAt(1);
          if (this.flowKey || isEmpty(next) || next === ",") {
            this.flowKey = false;
            yield* this.pushCount(1);
            yield* this.pushSpaces(true);
            return "flow";
          }
        }
        default:
          this.flowKey = false;
          return yield* this.parsePlainScalar();
      }
    }
    *parseQuotedScalar() {
      const quote = this.charAt(0);
      let end = this.buffer.indexOf(quote, this.pos + 1);
      if (quote === "'") {
        while (end !== -1 && this.buffer[end + 1] === "'")
          end = this.buffer.indexOf("'", end + 2);
      } else {
        while (end !== -1) {
          let n = 0;
          while (this.buffer[end - 1 - n] === "\\")
            n += 1;
          if (n % 2 === 0)
            break;
          end = this.buffer.indexOf('"', end + 1);
        }
      }
      const qb = this.buffer.substring(0, end);
      let nl = qb.indexOf(`
`, this.pos);
      if (nl !== -1) {
        while (nl !== -1) {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = qb.indexOf(`
`, cs);
        }
        if (nl !== -1) {
          end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
        }
      }
      if (end === -1) {
        if (!this.atEnd)
          return this.setNext("quoted-scalar");
        end = this.buffer.length;
      }
      yield* this.pushToIndex(end + 1, false);
      return this.flowLevel ? "flow" : "doc";
    }
    *parseBlockScalarHeader() {
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      let i = this.pos;
      while (true) {
        const ch = this.buffer[++i];
        if (ch === "+")
          this.blockScalarKeep = true;
        else if (ch > "0" && ch <= "9")
          this.blockScalarIndent = Number(ch) - 1;
        else if (ch !== "-")
          break;
      }
      return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
    }
    *parseBlockScalar() {
      let nl = this.pos - 1;
      let indent = 0;
      let ch;
      loop:
        for (let i = this.pos;ch = this.buffer[i]; ++i) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case `
`:
              nl = i;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === `
`)
                break;
            }
            default:
              break loop;
          }
        }
      if (!ch && !this.atEnd)
        return this.setNext("block-scalar");
      if (indent >= this.indentNext) {
        if (this.blockScalarIndent === -1)
          this.indentNext = indent;
        else {
          this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
        }
        do {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = this.buffer.indexOf(`
`, cs);
        } while (nl !== -1);
        if (nl === -1) {
          if (!this.atEnd)
            return this.setNext("block-scalar");
          nl = this.buffer.length;
        }
      }
      let i = nl + 1;
      ch = this.buffer[i];
      while (ch === " ")
        ch = this.buffer[++i];
      if (ch === "\t") {
        while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
          ch = this.buffer[++i];
        nl = i - 1;
      } else if (!this.blockScalarKeep) {
        do {
          let i = nl - 1;
          let ch = this.buffer[i];
          if (ch === "\r")
            ch = this.buffer[--i];
          const lastChar = i;
          while (ch === " ")
            ch = this.buffer[--i];
          if (ch === `
` && i >= this.pos && i + 1 + indent > lastChar)
            nl = i;
          else
            break;
        } while (true);
      }
      yield cst.SCALAR;
      yield* this.pushToIndex(nl + 1, true);
      return yield* this.parseLineStart();
    }
    *parsePlainScalar() {
      const inFlow = this.flowLevel > 0;
      let end = this.pos - 1;
      let i = this.pos - 1;
      let ch;
      while (ch = this.buffer[++i]) {
        if (ch === ":") {
          const next = this.buffer[i + 1];
          if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
            break;
          end = i;
        } else if (isEmpty(ch)) {
          let next = this.buffer[i + 1];
          if (ch === "\r") {
            if (next === `
`) {
              i += 1;
              ch = `
`;
              next = this.buffer[i + 1];
            } else
              end = i;
          }
          if (next === "#" || inFlow && flowIndicatorChars.has(next))
            break;
          if (ch === `
`) {
            const cs = this.continueScalar(i + 1);
            if (cs === -1)
              break;
            i = Math.max(i, cs - 2);
          }
        } else {
          if (inFlow && flowIndicatorChars.has(ch))
            break;
          end = i;
        }
      }
      if (!ch && !this.atEnd)
        return this.setNext("plain-scalar");
      yield cst.SCALAR;
      yield* this.pushToIndex(end + 1, true);
      return inFlow ? "flow" : "doc";
    }
    *pushCount(n) {
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos += n;
        return n;
      }
      return 0;
    }
    *pushToIndex(i, allowEmpty) {
      const s = this.buffer.slice(this.pos, i);
      if (s) {
        yield s;
        this.pos += s.length;
        return s.length;
      } else if (allowEmpty)
        yield "";
      return 0;
    }
    *pushIndicators() {
      let n = 0;
      loop:
        while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            case "?":
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
      return n;
    }
    *pushTag() {
      if (this.charAt(1) === "<") {
        let i = this.pos + 2;
        let ch = this.buffer[i];
        while (!isEmpty(ch) && ch !== ">")
          ch = this.buffer[++i];
        return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
      } else {
        let i = this.pos + 1;
        let ch = this.buffer[i];
        while (ch) {
          if (tagChars.has(ch))
            ch = this.buffer[++i];
          else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
            ch = this.buffer[i += 3];
          } else
            break;
        }
        return yield* this.pushToIndex(i, false);
      }
    }
    *pushNewline() {
      const ch = this.buffer[this.pos];
      if (ch === `
`)
        return yield* this.pushCount(1);
      else if (ch === "\r" && this.charAt(1) === `
`)
        return yield* this.pushCount(2);
      else
        return 0;
    }
    *pushSpaces(allowTabs) {
      let i = this.pos - 1;
      let ch;
      do {
        ch = this.buffer[++i];
      } while (ch === " " || allowTabs && ch === "\t");
      const n = i - this.pos;
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos = i;
      }
      return n;
    }
    *pushUntil(test) {
      let i = this.pos;
      let ch = this.buffer[i];
      while (!test(ch))
        ch = this.buffer[++i];
      return yield* this.pushToIndex(i, false);
    }
  }
  exports.Lexer = Lexer;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS(function(exports) {
  class LineCounter {
    constructor() {
      this.lineStarts = [];
      this.addNewLine = (offset) => this.lineStarts.push(offset);
      this.linePos = (offset) => {
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
          const mid = low + high >> 1;
          if (this.lineStarts[mid] < offset)
            low = mid + 1;
          else
            high = mid;
        }
        if (this.lineStarts[low] === offset)
          return { line: low + 1, col: 1 };
        if (low === 0)
          return { line: 0, col: offset };
        const start = this.lineStarts[low - 1];
        return { line: low, col: offset - start + 1 };
      };
    }
  }
  exports.LineCounter = LineCounter;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS(function(exports) {
  var node_process = __require("process");
  var cst = require_cst();
  var lexer = require_lexer();
  function includesToken(list, type) {
    for (let i = 0;i < list.length; ++i)
      if (list[i].type === type)
        return true;
    return false;
  }
  function findNonEmptyIndex(list) {
    for (let i = 0;i < list.length; ++i) {
      switch (list[i].type) {
        case "space":
        case "comment":
        case "newline":
          break;
        default:
          return i;
      }
    }
    return -1;
  }
  function isFlowToken(token) {
    switch (token?.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "flow-collection":
        return true;
      default:
        return false;
    }
  }
  function getPrevProps(parent) {
    switch (parent.type) {
      case "document":
        return parent.start;
      case "block-map": {
        const it = parent.items[parent.items.length - 1];
        return it.sep ?? it.start;
      }
      case "block-seq":
        return parent.items[parent.items.length - 1].start;
      default:
        return [];
    }
  }
  function getFirstKeyStartProps(prev) {
    if (prev.length === 0)
      return [];
    let i = prev.length;
    loop:
      while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
    while (prev[++i]?.type === "space") {}
    return prev.splice(i, prev.length);
  }
  function arrayPushArray(target, source) {
    if (source.length < 1e5)
      Array.prototype.push.apply(target, source);
    else
      for (let i = 0;i < source.length; ++i)
        target.push(source[i]);
  }
  function fixFlowSeqItems(fc) {
    if (fc.start.type === "flow-seq-start") {
      for (const it of fc.items) {
        if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
          if (it.key)
            it.value = it.key;
          delete it.key;
          if (isFlowToken(it.value)) {
            if (it.value.end)
              arrayPushArray(it.value.end, it.sep);
            else
              it.value.end = it.sep;
          } else
            arrayPushArray(it.start, it.sep);
          delete it.sep;
        }
      }
    }
  }

  class Parser {
    constructor(onNewLine) {
      this.atNewLine = true;
      this.atScalar = false;
      this.indent = 0;
      this.offset = 0;
      this.onKeyLine = false;
      this.stack = [];
      this.source = "";
      this.type = "";
      this.lexer = new lexer.Lexer;
      this.onNewLine = onNewLine;
    }
    *parse(source, incomplete = false) {
      if (this.onNewLine && this.offset === 0)
        this.onNewLine(0);
      for (const lexeme of this.lexer.lex(source, incomplete))
        yield* this.next(lexeme);
      if (!incomplete)
        yield* this.end();
    }
    *next(source) {
      this.source = source;
      if (node_process.env.LOG_TOKENS)
        console.log("|", cst.prettyToken(source));
      if (this.atScalar) {
        this.atScalar = false;
        yield* this.step();
        this.offset += source.length;
        return;
      }
      const type = cst.tokenType(source);
      if (!type) {
        const message = `Not a YAML token: ${source}`;
        yield* this.pop({ type: "error", offset: this.offset, message, source });
        this.offset += source.length;
      } else if (type === "scalar") {
        this.atNewLine = false;
        this.atScalar = true;
        this.type = "scalar";
      } else {
        this.type = type;
        yield* this.step();
        switch (type) {
          case "newline":
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine)
              this.onNewLine(this.offset + source.length);
            break;
          case "space":
            if (this.atNewLine && source[0] === " ")
              this.indent += source.length;
            break;
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
            if (this.atNewLine)
              this.indent += source.length;
            break;
          case "doc-mode":
          case "flow-error-end":
            return;
          default:
            this.atNewLine = false;
        }
        this.offset += source.length;
      }
    }
    *end() {
      while (this.stack.length > 0)
        yield* this.pop();
    }
    get sourceToken() {
      const st = {
        type: this.type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
      return st;
    }
    *step() {
      const top = this.peek(1);
      if (this.type === "doc-end" && top?.type !== "doc-end") {
        while (this.stack.length > 0)
          yield* this.pop();
        this.stack.push({
          type: "doc-end",
          offset: this.offset,
          source: this.source
        });
        return;
      }
      if (!top)
        return yield* this.stream();
      switch (top.type) {
        case "document":
          return yield* this.document(top);
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return yield* this.scalar(top);
        case "block-scalar":
          return yield* this.blockScalar(top);
        case "block-map":
          return yield* this.blockMap(top);
        case "block-seq":
          return yield* this.blockSequence(top);
        case "flow-collection":
          return yield* this.flowCollection(top);
        case "doc-end":
          return yield* this.documentEnd(top);
      }
      yield* this.pop();
    }
    peek(n) {
      return this.stack[this.stack.length - n];
    }
    *pop(error) {
      const token = error ?? this.stack.pop();
      if (!token) {
        const message = "Tried to pop an empty stack";
        yield { type: "error", offset: this.offset, source: "", message };
      } else if (this.stack.length === 0) {
        yield token;
      } else {
        const top = this.peek(1);
        if (token.type === "block-scalar") {
          token.indent = "indent" in top ? top.indent : 0;
        } else if (token.type === "flow-collection" && top.type === "document") {
          token.indent = 0;
        }
        if (token.type === "flow-collection")
          fixFlowSeqItems(token);
        switch (top.type) {
          case "document":
            top.value = token;
            break;
          case "block-scalar":
            top.props.push(token);
            break;
          case "block-map": {
            const it = top.items[top.items.length - 1];
            if (it.value) {
              top.items.push({ start: [], key: token, sep: [] });
              this.onKeyLine = true;
              return;
            } else if (it.sep) {
              it.value = token;
            } else {
              Object.assign(it, { key: token, sep: [] });
              this.onKeyLine = !it.explicitKey;
              return;
            }
            break;
          }
          case "block-seq": {
            const it = top.items[top.items.length - 1];
            if (it.value)
              top.items.push({ start: [], value: token });
            else
              it.value = token;
            break;
          }
          case "flow-collection": {
            const it = top.items[top.items.length - 1];
            if (!it || it.value)
              top.items.push({ start: [], key: token, sep: [] });
            else if (it.sep)
              it.value = token;
            else
              Object.assign(it, { key: token, sep: [] });
            return;
          }
          default:
            yield* this.pop();
            yield* this.pop(token);
        }
        if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
          const last = token.items[token.items.length - 1];
          if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
            if (top.type === "document")
              top.end = last.start;
            else
              top.items.push({ start: last.start });
            token.items.splice(-1, 1);
          }
        }
      }
    }
    *stream() {
      switch (this.type) {
        case "directive-line":
          yield { type: "directive", offset: this.offset, source: this.source };
          return;
        case "byte-order-mark":
        case "space":
        case "comment":
        case "newline":
          yield this.sourceToken;
          return;
        case "doc-mode":
        case "doc-start": {
          const doc = {
            type: "document",
            offset: this.offset,
            start: []
          };
          if (this.type === "doc-start")
            doc.start.push(this.sourceToken);
          this.stack.push(doc);
          return;
        }
      }
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML stream`,
        source: this.source
      };
    }
    *document(doc) {
      if (doc.value)
        return yield* this.lineEnd(doc);
      switch (this.type) {
        case "doc-start": {
          if (findNonEmptyIndex(doc.start) !== -1) {
            yield* this.pop();
            yield* this.step();
          } else
            doc.start.push(this.sourceToken);
          return;
        }
        case "anchor":
        case "tag":
        case "space":
        case "comment":
        case "newline":
          doc.start.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(doc);
      if (bv)
        this.stack.push(bv);
      else {
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML document`,
          source: this.source
        };
      }
    }
    *scalar(scalar) {
      if (this.type === "map-value-ind") {
        const prev = getPrevProps(this.peek(2));
        const start = getFirstKeyStartProps(prev);
        let sep;
        if (scalar.end) {
          sep = scalar.end;
          sep.push(this.sourceToken);
          delete scalar.end;
        } else
          sep = [this.sourceToken];
        const map = {
          type: "block-map",
          offset: scalar.offset,
          indent: scalar.indent,
          items: [{ start, key: scalar, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else
        yield* this.lineEnd(scalar);
    }
    *blockScalar(scalar) {
      switch (this.type) {
        case "space":
        case "comment":
        case "newline":
          scalar.props.push(this.sourceToken);
          return;
        case "scalar":
          scalar.source = this.source;
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine) {
            let nl = this.source.indexOf(`
`) + 1;
            while (nl !== 0) {
              this.onNewLine(this.offset + nl);
              nl = this.source.indexOf(`
`, nl) + 1;
            }
          }
          yield* this.pop();
          break;
        default:
          yield* this.pop();
          yield* this.step();
      }
    }
    *blockMap(map) {
      const it = map.items[map.items.length - 1];
      switch (this.type) {
        case "newline":
          this.onKeyLine = false;
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "space":
        case "comment":
          if (it.value) {
            map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            if (this.atIndentedComment(it.start, map.indent)) {
              const prev = map.items[map.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                arrayPushArray(end, it.start);
                end.push(this.sourceToken);
                map.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
      }
      if (this.indent >= map.indent) {
        const atMapIndent = !this.onKeyLine && this.indent === map.indent;
        const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
        let start = [];
        if (atNextItem && it.sep && !it.value) {
          const nl = [];
          for (let i = 0;i < it.sep.length; ++i) {
            const st = it.sep[i];
            switch (st.type) {
              case "newline":
                nl.push(i);
                break;
              case "space":
                break;
              case "comment":
                if (st.indent > map.indent)
                  nl.length = 0;
                break;
              default:
                nl.length = 0;
            }
          }
          if (nl.length >= 2)
            start = it.sep.splice(nl[1]);
        }
        switch (this.type) {
          case "anchor":
          case "tag":
            if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start });
              this.onKeyLine = true;
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "explicit-key-ind":
            if (!it.sep && !it.explicitKey) {
              it.start.push(this.sourceToken);
              it.explicitKey = true;
            } else if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start, explicitKey: true });
            } else {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [this.sourceToken], explicitKey: true }]
              });
            }
            this.onKeyLine = true;
            return;
          case "map-value-ind":
            if (it.explicitKey) {
              if (!it.sep) {
                if (includesToken(it.start, "newline")) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else {
                  const start = getFirstKeyStartProps(it.start);
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                }
              } else if (it.value) {
                map.items.push({ start: [], key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                const start = getFirstKeyStartProps(it.start);
                const key = it.key;
                const sep = it.sep;
                sep.push(this.sourceToken);
                delete it.key;
                delete it.sep;
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key, sep }]
                });
              } else if (start.length > 0) {
                it.sep = it.sep.concat(start, this.sourceToken);
              } else {
                it.sep.push(this.sourceToken);
              }
            } else {
              if (!it.sep) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else if (it.value || atNextItem) {
                map.items.push({ start, key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [], key: null, sep: [this.sourceToken] }]
                });
              } else {
                it.sep.push(this.sourceToken);
              }
            }
            this.onKeyLine = true;
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (atNextItem || it.value) {
              map.items.push({ start, key: fs, sep: [] });
              this.onKeyLine = true;
            } else if (it.sep) {
              this.stack.push(fs);
            } else {
              Object.assign(it, { key: fs, sep: [] });
              this.onKeyLine = true;
            }
            return;
          }
          default: {
            const bv = this.startBlockValue(map);
            if (bv) {
              if (bv.type === "block-seq") {
                if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                  yield* this.pop({
                    type: "error",
                    offset: this.offset,
                    message: "Unexpected block-seq-ind on same line with key",
                    source: this.source
                  });
                  return;
                }
              } else if (atMapIndent) {
                map.items.push({ start });
              }
              this.stack.push(bv);
              return;
            }
          }
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *blockSequence(seq) {
      const it = seq.items[seq.items.length - 1];
      switch (this.type) {
        case "newline":
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              seq.items.push({ start: [this.sourceToken] });
          } else
            it.start.push(this.sourceToken);
          return;
        case "space":
        case "comment":
          if (it.value)
            seq.items.push({ start: [this.sourceToken] });
          else {
            if (this.atIndentedComment(it.start, seq.indent)) {
              const prev = seq.items[seq.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                arrayPushArray(end, it.start);
                end.push(this.sourceToken);
                seq.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
        case "anchor":
        case "tag":
          if (it.value || this.indent <= seq.indent)
            break;
          it.start.push(this.sourceToken);
          return;
        case "seq-item-ind":
          if (this.indent !== seq.indent)
            break;
          if (it.value || includesToken(it.start, "seq-item-ind"))
            seq.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
      }
      if (this.indent > seq.indent) {
        const bv = this.startBlockValue(seq);
        if (bv) {
          this.stack.push(bv);
          return;
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *flowCollection(fc) {
      const it = fc.items[fc.items.length - 1];
      if (this.type === "flow-error-end") {
        let top;
        do {
          yield* this.pop();
          top = this.peek(1);
        } while (top?.type === "flow-collection");
      } else if (fc.end.length === 0) {
        switch (this.type) {
          case "comma":
          case "explicit-key-ind":
            if (!it || it.sep)
              fc.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
          case "map-value-ind":
            if (!it || it.value)
              fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            return;
          case "space":
          case "comment":
          case "newline":
          case "anchor":
          case "tag":
            if (!it || it.value)
              fc.items.push({ start: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              it.start.push(this.sourceToken);
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (!it || it.value)
              fc.items.push({ start: [], key: fs, sep: [] });
            else if (it.sep)
              this.stack.push(fs);
            else
              Object.assign(it, { key: fs, sep: [] });
            return;
          }
          case "flow-map-end":
          case "flow-seq-end":
            fc.end.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(fc);
        if (bv)
          this.stack.push(bv);
        else {
          yield* this.pop();
          yield* this.step();
        }
      } else {
        const parent = this.peek(2);
        if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
          yield* this.pop();
          yield* this.step();
        } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          fixFlowSeqItems(fc);
          const sep = fc.end.splice(1, fc.end.length);
          sep.push(this.sourceToken);
          const map = {
            type: "block-map",
            offset: fc.offset,
            indent: fc.indent,
            items: [{ start, key: fc, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else {
          yield* this.lineEnd(fc);
        }
      }
    }
    flowScalar(type) {
      if (this.onNewLine) {
        let nl = this.source.indexOf(`
`) + 1;
        while (nl !== 0) {
          this.onNewLine(this.offset + nl);
          nl = this.source.indexOf(`
`, nl) + 1;
        }
      }
      return {
        type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
    }
    startBlockValue(parent) {
      switch (this.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return this.flowScalar(this.type);
        case "block-scalar-header":
          return {
            type: "block-scalar",
            offset: this.offset,
            indent: this.indent,
            props: [this.sourceToken],
            source: ""
          };
        case "flow-map-start":
        case "flow-seq-start":
          return {
            type: "flow-collection",
            offset: this.offset,
            indent: this.indent,
            start: this.sourceToken,
            items: [],
            end: []
          };
        case "seq-item-ind":
          return {
            type: "block-seq",
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken] }]
          };
        case "explicit-key-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          start.push(this.sourceToken);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, explicitKey: true }]
          };
        }
        case "map-value-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, key: null, sep: [this.sourceToken] }]
          };
        }
      }
      return null;
    }
    atIndentedComment(start, indent) {
      if (this.type !== "comment")
        return false;
      if (this.indent <= indent)
        return false;
      return start.every((st) => st.type === "newline" || st.type === "space");
    }
    *documentEnd(docEnd) {
      if (this.type !== "doc-mode") {
        if (docEnd.end)
          docEnd.end.push(this.sourceToken);
        else
          docEnd.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
      }
    }
    *lineEnd(token) {
      switch (this.type) {
        case "comma":
        case "doc-start":
        case "doc-end":
        case "flow-seq-end":
        case "flow-map-end":
        case "map-value-ind":
          yield* this.pop();
          yield* this.step();
          break;
        case "newline":
          this.onKeyLine = false;
        case "space":
        case "comment":
        default:
          if (token.end)
            token.end.push(this.sourceToken);
          else
            token.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
      }
    }
  }
  exports.Parser = Parser;
});

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS(function(exports) {
  var composer = require_composer();
  var Document = require_Document();
  var errors = require_errors();
  var log = require_log();
  var identity = require_identity();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  function parseOptions(options) {
    const prettyErrors = options.prettyErrors !== false;
    const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter || null;
    return { lineCounter: lineCounter$1, prettyErrors };
  }
  function parseAllDocuments(source, options = {}) {
    const { lineCounter, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter?.addNewLine);
    const composer$1 = new composer.Composer(options);
    const docs = Array.from(composer$1.compose(parser$1.parse(source)));
    if (prettyErrors && lineCounter)
      for (const doc of docs) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter));
      }
    if (docs.length > 0)
      return docs;
    return Object.assign([], { empty: true }, composer$1.streamInfo());
  }
  function parseDocument(source, options = {}) {
    const { lineCounter, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter?.addNewLine);
    const composer$1 = new composer.Composer(options);
    let doc = null;
    for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
      if (!doc)
        doc = _doc;
      else if (doc.options.logLevel !== "silent") {
        doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
        break;
      }
    }
    if (prettyErrors && lineCounter) {
      doc.errors.forEach(errors.prettifyError(source, lineCounter));
      doc.warnings.forEach(errors.prettifyError(source, lineCounter));
    }
    return doc;
  }
  function parse(src, reviver, options) {
    let _reviver = undefined;
    if (typeof reviver === "function") {
      _reviver = reviver;
    } else if (options === undefined && reviver && typeof reviver === "object") {
      options = reviver;
    }
    const doc = parseDocument(src, options);
    if (!doc)
      return null;
    doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
    if (doc.errors.length > 0) {
      if (doc.options.logLevel !== "silent")
        throw doc.errors[0];
      else
        doc.errors = [];
    }
    return doc.toJS(Object.assign({ reviver: _reviver }, options));
  }
  function stringify(value, replacer, options) {
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
    }
    if (typeof options === "string")
      options = options.length;
    if (typeof options === "number") {
      const indent = Math.round(options);
      options = indent < 1 ? undefined : indent > 8 ? { indent: 8 } : { indent };
    }
    if (value === undefined) {
      const { keepUndefined } = options ?? replacer ?? {};
      if (!keepUndefined)
        return;
    }
    if (identity.isDocument(value) && !_replacer)
      return value.toString(options);
    return new Document.Document(value, _replacer, options).toString(options);
  }
  exports.parse = parse;
  exports.parseAllDocuments = parseAllDocuments;
  exports.parseDocument = parseDocument;
  exports.stringify = stringify;
});

// node_modules/.bun/commander@15.0.0/node_modules/commander/lib/error.js
class CommanderError extends Error {
  constructor(exitCode, code, message) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    this.nestedError = undefined;
  }
}

class InvalidArgumentError extends CommanderError {
  constructor(message) {
    super(1, "commander.invalidArgument", message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
  }
}

// node_modules/.bun/commander@15.0.0/node_modules/commander/lib/argument.js
class Argument {
  constructor(name, description) {
    this.description = description || "";
    this.variadic = false;
    this.parseArg = undefined;
    this.defaultValue = undefined;
    this.defaultValueDescription = undefined;
    this.argChoices = undefined;
    switch (name[0]) {
      case "<":
        this.required = true;
        this._name = name.slice(1, -1);
        break;
      case "[":
        this.required = false;
        this._name = name.slice(1, -1);
        break;
      default:
        this.required = true;
        this._name = name;
        break;
    }
    if (this._name.endsWith("...")) {
      this.variadic = true;
      this._name = this._name.slice(0, -3);
    }
  }
  name() {
    return this._name;
  }
  _collectValue(value, previous) {
    if (previous === this.defaultValue || !Array.isArray(previous)) {
      return [value];
    }
    previous.push(value);
    return previous;
  }
  default(value, description) {
    this.defaultValue = value;
    this.defaultValueDescription = description;
    return this;
  }
  argParser(fn) {
    this.parseArg = fn;
    return this;
  }
  choices(values) {
    this.argChoices = values.slice();
    this.parseArg = (arg, previous) => {
      if (!this.argChoices.includes(arg)) {
        throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
      }
      if (this.variadic) {
        return this._collectValue(arg, previous);
      }
      return arg;
    };
    return this;
  }
  argRequired() {
    this.required = true;
    return this;
  }
  argOptional() {
    this.required = false;
    return this;
  }
}
function humanReadableArgName(arg) {
  const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
  return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
}

// node_modules/.bun/commander@15.0.0/node_modules/commander/lib/command.js
import { EventEmitter } from "events";
import childProcess from "child_process";
import path from "path";
import fs from "fs";
import process2 from "process";
import { stripVTControlCharacters as stripVTControlCharacters2 } from "util";

// node_modules/.bun/commander@15.0.0/node_modules/commander/lib/help.js
import { stripVTControlCharacters } from "util";

class Help {
  constructor() {
    this.helpWidth = undefined;
    this.minWidthToWrap = 40;
    this.sortSubcommands = false;
    this.sortOptions = false;
    this.showGlobalOptions = false;
  }
  prepareContext(contextOptions) {
    this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
  }
  visibleCommands(cmd) {
    const visibleCommands = cmd.commands.filter((cmd) => !cmd._hidden);
    const helpCommand = cmd._getHelpCommand();
    if (helpCommand && !helpCommand._hidden) {
      visibleCommands.push(helpCommand);
    }
    if (this.sortSubcommands) {
      visibleCommands.sort((a, b) => {
        return a.name().localeCompare(b.name());
      });
    }
    return visibleCommands;
  }
  compareOptions(a, b) {
    const getSortKey = (option) => {
      return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
    };
    return getSortKey(a).localeCompare(getSortKey(b));
  }
  visibleOptions(cmd) {
    const visibleOptions = cmd.options.filter((option) => !option.hidden);
    const helpOption = cmd._getHelpOption();
    if (helpOption && !helpOption.hidden) {
      const removeShort = helpOption.short && cmd._findOption(helpOption.short);
      const removeLong = helpOption.long && cmd._findOption(helpOption.long);
      if (!removeShort && !removeLong) {
        visibleOptions.push(helpOption);
      } else if (helpOption.long && !removeLong) {
        visibleOptions.push(cmd.createOption(helpOption.long, helpOption.description));
      } else if (helpOption.short && !removeShort) {
        visibleOptions.push(cmd.createOption(helpOption.short, helpOption.description));
      }
    }
    if (this.sortOptions) {
      visibleOptions.sort(this.compareOptions);
    }
    return visibleOptions;
  }
  visibleGlobalOptions(cmd) {
    if (!this.showGlobalOptions)
      return [];
    const globalOptions = [];
    for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
      const visibleOptions = ancestorCmd.options.filter((option) => !option.hidden);
      globalOptions.push(...visibleOptions);
    }
    if (this.sortOptions) {
      globalOptions.sort(this.compareOptions);
    }
    return globalOptions;
  }
  visibleArguments(cmd) {
    if (cmd._argsDescription) {
      cmd.registeredArguments.forEach((argument) => {
        argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
      });
    }
    if (cmd.registeredArguments.find((argument) => argument.description)) {
      return cmd.registeredArguments;
    }
    return [];
  }
  subcommandTerm(cmd) {
    const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
    return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + (args ? " " + args : "");
  }
  optionTerm(option) {
    return option.flags;
  }
  argumentTerm(argument) {
    return argument.name();
  }
  longestSubcommandTermLength(cmd, helper) {
    return helper.visibleCommands(cmd).reduce((max, command) => {
      return Math.max(max, this.displayWidth(helper.styleSubcommandTerm(helper.subcommandTerm(command))));
    }, 0);
  }
  longestOptionTermLength(cmd, helper) {
    return helper.visibleOptions(cmd).reduce((max, option) => {
      return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
    }, 0);
  }
  longestGlobalOptionTermLength(cmd, helper) {
    return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
      return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
    }, 0);
  }
  longestArgumentTermLength(cmd, helper) {
    return helper.visibleArguments(cmd).reduce((max, argument) => {
      return Math.max(max, this.displayWidth(helper.styleArgumentTerm(helper.argumentTerm(argument))));
    }, 0);
  }
  commandUsage(cmd) {
    let cmdName = cmd._name;
    if (cmd._aliases[0]) {
      cmdName = cmdName + "|" + cmd._aliases[0];
    }
    let ancestorCmdNames = "";
    for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
      ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
    }
    return ancestorCmdNames + cmdName + " " + cmd.usage();
  }
  commandDescription(cmd) {
    return cmd.description();
  }
  subcommandDescription(cmd) {
    return cmd.summary() || cmd.description();
  }
  optionDescription(option) {
    const extraInfo = [];
    if (option.argChoices) {
      extraInfo.push(`choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
    }
    if (option.defaultValue !== undefined) {
      const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
      if (showDefault) {
        extraInfo.push(`default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`);
      }
    }
    if (option.presetArg !== undefined && option.optional) {
      extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
    }
    if (option.envVar !== undefined) {
      extraInfo.push(`env: ${option.envVar}`);
    }
    if (extraInfo.length > 0) {
      const extraDescription = `(${extraInfo.join(", ")})`;
      if (option.description) {
        return `${option.description} ${extraDescription}`;
      }
      return extraDescription;
    }
    return option.description;
  }
  argumentDescription(argument) {
    const extraInfo = [];
    if (argument.argChoices) {
      extraInfo.push(`choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
    }
    if (argument.defaultValue !== undefined) {
      extraInfo.push(`default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`);
    }
    if (extraInfo.length > 0) {
      const extraDescription = `(${extraInfo.join(", ")})`;
      if (argument.description) {
        return `${argument.description} ${extraDescription}`;
      }
      return extraDescription;
    }
    return argument.description;
  }
  formatItemList(heading, items, helper) {
    if (items.length === 0)
      return [];
    return [helper.styleTitle(heading), ...items, ""];
  }
  groupItems(unsortedItems, visibleItems, getGroup) {
    const result = new Map;
    unsortedItems.forEach((item) => {
      const group = getGroup(item);
      if (!result.has(group))
        result.set(group, []);
    });
    visibleItems.forEach((item) => {
      const group = getGroup(item);
      if (!result.has(group)) {
        result.set(group, []);
      }
      result.get(group).push(item);
    });
    return result;
  }
  formatHelp(cmd, helper) {
    const termWidth = helper.padWidth(cmd, helper);
    const helpWidth = helper.helpWidth ?? 80;
    function callFormatItem(term, description) {
      return helper.formatItem(term, termWidth, description, helper);
    }
    let output = [
      `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
      ""
    ];
    const commandDescription = helper.commandDescription(cmd);
    if (commandDescription.length > 0) {
      output = output.concat([
        helper.boxWrap(helper.styleCommandDescription(commandDescription), helpWidth),
        ""
      ]);
    }
    const argumentList = helper.visibleArguments(cmd).map((argument) => {
      return callFormatItem(helper.styleArgumentTerm(helper.argumentTerm(argument)), helper.styleArgumentDescription(helper.argumentDescription(argument)));
    });
    output = output.concat(this.formatItemList("Arguments:", argumentList, helper));
    const optionGroups = this.groupItems(cmd.options, helper.visibleOptions(cmd), (option) => option.helpGroupHeading ?? "Options:");
    optionGroups.forEach((options, group) => {
      const optionList = options.map((option) => {
        return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
      });
      output = output.concat(this.formatItemList(group, optionList, helper));
    });
    if (helper.showGlobalOptions) {
      const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
        return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
      });
      output = output.concat(this.formatItemList("Global Options:", globalOptionList, helper));
    }
    const commandGroups = this.groupItems(cmd.commands, helper.visibleCommands(cmd), (sub) => sub.helpGroup() || "Commands:");
    commandGroups.forEach((commands, group) => {
      const commandList = commands.map((sub) => {
        return callFormatItem(helper.styleSubcommandTerm(helper.subcommandTerm(sub)), helper.styleSubcommandDescription(helper.subcommandDescription(sub)));
      });
      output = output.concat(this.formatItemList(group, commandList, helper));
    });
    return output.join(`
`);
  }
  displayWidth(str) {
    return stripVTControlCharacters(str).length;
  }
  styleTitle(str) {
    return str;
  }
  styleUsage(str) {
    return str.split(" ").map((word) => {
      if (word === "[options]")
        return this.styleOptionText(word);
      if (word === "[command]")
        return this.styleSubcommandText(word);
      if (word[0] === "[" || word[0] === "<")
        return this.styleArgumentText(word);
      return this.styleCommandText(word);
    }).join(" ");
  }
  styleCommandDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleOptionDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleSubcommandDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleArgumentDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleDescriptionText(str) {
    return str;
  }
  styleOptionTerm(str) {
    return this.styleOptionText(str);
  }
  styleSubcommandTerm(str) {
    return str.split(" ").map((word) => {
      if (word === "[options]")
        return this.styleOptionText(word);
      if (word[0] === "[" || word[0] === "<")
        return this.styleArgumentText(word);
      return this.styleSubcommandText(word);
    }).join(" ");
  }
  styleArgumentTerm(str) {
    return this.styleArgumentText(str);
  }
  styleOptionText(str) {
    return str;
  }
  styleArgumentText(str) {
    return str;
  }
  styleSubcommandText(str) {
    return str;
  }
  styleCommandText(str) {
    return str;
  }
  padWidth(cmd, helper) {
    return Math.max(helper.longestOptionTermLength(cmd, helper), helper.longestGlobalOptionTermLength(cmd, helper), helper.longestSubcommandTermLength(cmd, helper), helper.longestArgumentTermLength(cmd, helper));
  }
  preformatted(str) {
    return /\n[^\S\r\n]/.test(str);
  }
  formatItem(term, termWidth, description, helper) {
    const itemIndent = 2;
    const itemIndentStr = " ".repeat(itemIndent);
    if (!description)
      return itemIndentStr + term;
    const paddedTerm = term.padEnd(termWidth + term.length - helper.displayWidth(term));
    const spacerWidth = 2;
    const helpWidth = this.helpWidth ?? 80;
    const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
    let formattedDescription;
    if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
      formattedDescription = description;
    } else {
      const wrappedDescription = helper.boxWrap(description, remainingWidth);
      formattedDescription = wrappedDescription.replace(/\n/g, `
` + " ".repeat(termWidth + spacerWidth));
    }
    return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
  }
  boxWrap(str, width) {
    if (width < this.minWidthToWrap)
      return str;
    const rawLines = str.split(/\r\n|\n/);
    const chunkPattern = /[\s]*[^\s]+/g;
    const wrappedLines = [];
    rawLines.forEach((line) => {
      const chunks = line.match(chunkPattern);
      if (chunks === null) {
        wrappedLines.push("");
        return;
      }
      let sumChunks = [chunks.shift()];
      let sumWidth = this.displayWidth(sumChunks[0]);
      chunks.forEach((chunk) => {
        const visibleWidth = this.displayWidth(chunk);
        if (sumWidth + visibleWidth <= width) {
          sumChunks.push(chunk);
          sumWidth += visibleWidth;
          return;
        }
        wrappedLines.push(sumChunks.join(""));
        const nextChunk = chunk.trimStart();
        sumChunks = [nextChunk];
        sumWidth = this.displayWidth(nextChunk);
      });
      wrappedLines.push(sumChunks.join(""));
    });
    return wrappedLines.join(`
`);
  }
}

// node_modules/.bun/commander@15.0.0/node_modules/commander/lib/option.js
class Option {
  constructor(flags, description) {
    this.flags = flags;
    this.description = description || "";
    this.required = flags.includes("<");
    this.optional = flags.includes("[");
    this.variadic = /\w\.\.\.[>\]]$/.test(flags);
    this.mandatory = false;
    const optionFlags = splitOptionFlags(flags);
    this.short = optionFlags.shortFlag;
    this.long = optionFlags.longFlag;
    this.negate = false;
    if (this.long) {
      this.negate = this.long.startsWith("--no-");
    }
    this.defaultValue = undefined;
    this.defaultValueDescription = undefined;
    this.presetArg = undefined;
    this.envVar = undefined;
    this.parseArg = undefined;
    this.hidden = false;
    this.argChoices = undefined;
    this.conflictsWith = [];
    this.implied = undefined;
    this.helpGroupHeading = undefined;
  }
  default(value, description) {
    this.defaultValue = value;
    this.defaultValueDescription = description;
    return this;
  }
  preset(arg) {
    this.presetArg = arg;
    return this;
  }
  conflicts(names) {
    this.conflictsWith = this.conflictsWith.concat(names);
    return this;
  }
  implies(impliedOptionValues) {
    let newImplied = impliedOptionValues;
    if (typeof impliedOptionValues === "string") {
      newImplied = { [impliedOptionValues]: true };
    }
    this.implied = Object.assign(this.implied || {}, newImplied);
    return this;
  }
  env(name) {
    this.envVar = name;
    return this;
  }
  argParser(fn) {
    this.parseArg = fn;
    return this;
  }
  makeOptionMandatory(mandatory = true) {
    this.mandatory = !!mandatory;
    return this;
  }
  hideHelp(hide = true) {
    this.hidden = !!hide;
    return this;
  }
  _collectValue(value, previous) {
    if (previous === this.defaultValue || !Array.isArray(previous)) {
      return [value];
    }
    previous.push(value);
    return previous;
  }
  choices(values) {
    this.argChoices = values.slice();
    this.parseArg = (arg, previous) => {
      if (!this.argChoices.includes(arg)) {
        throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
      }
      if (this.variadic) {
        return this._collectValue(arg, previous);
      }
      return arg;
    };
    return this;
  }
  name() {
    if (this.long) {
      return this.long.replace(/^--/, "");
    }
    return this.short.replace(/^-/, "");
  }
  attributeName() {
    if (this.negate) {
      return camelcase(this.name().replace(/^no-/, ""));
    }
    return camelcase(this.name());
  }
  helpGroup(heading) {
    this.helpGroupHeading = heading;
    return this;
  }
  is(arg) {
    return this.short === arg || this.long === arg;
  }
  isBoolean() {
    return !this.required && !this.optional && !this.negate;
  }
}

class DualOptions {
  constructor(options) {
    this.positiveOptions = new Map;
    this.negativeOptions = new Map;
    this.dualOptions = new Set;
    options.forEach((option) => {
      if (option.negate) {
        this.negativeOptions.set(option.attributeName(), option);
      } else {
        this.positiveOptions.set(option.attributeName(), option);
      }
    });
    this.negativeOptions.forEach((value, key) => {
      if (this.positiveOptions.has(key)) {
        this.dualOptions.add(key);
      }
    });
  }
  valueFromOption(value, option) {
    const optionKey = option.attributeName();
    if (!this.dualOptions.has(optionKey))
      return true;
    const preset = this.negativeOptions.get(optionKey).presetArg;
    const negativeValue = preset !== undefined ? preset : false;
    return option.negate === (negativeValue === value);
  }
}
function camelcase(str) {
  return str.split("-").reduce((str, word) => {
    return str + word[0].toUpperCase() + word.slice(1);
  });
}
function splitOptionFlags(flags) {
  let shortFlag;
  let longFlag;
  const shortFlagExp = /^-[^-]$/;
  const longFlagExp = /^--[^-]/;
  const flagParts = flags.split(/[ |,]+/).concat("guard");
  if (shortFlagExp.test(flagParts[0]))
    shortFlag = flagParts.shift();
  if (longFlagExp.test(flagParts[0]))
    longFlag = flagParts.shift();
  if (!shortFlag && shortFlagExp.test(flagParts[0]))
    shortFlag = flagParts.shift();
  if (!shortFlag && longFlagExp.test(flagParts[0])) {
    shortFlag = longFlag;
    longFlag = flagParts.shift();
  }
  if (flagParts[0].startsWith("-")) {
    const unsupportedFlag = flagParts[0];
    const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
    if (/^-[^-][^-]/.test(unsupportedFlag))
      throw new Error(`${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`);
    if (shortFlagExp.test(unsupportedFlag))
      throw new Error(`${baseError}
- too many short flags`);
    if (longFlagExp.test(unsupportedFlag))
      throw new Error(`${baseError}
- too many long flags`);
    throw new Error(`${baseError}
- unrecognised flag format`);
  }
  if (shortFlag === undefined && longFlag === undefined)
    throw new Error(`option creation failed due to no flags found in '${flags}'.`);
  return { shortFlag, longFlag };
}

// node_modules/.bun/commander@15.0.0/node_modules/commander/lib/suggestSimilar.js
var maxDistance = 3;
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > maxDistance)
    return Math.max(a.length, b.length);
  const d = [];
  for (let i = 0;i <= a.length; i++) {
    d[i] = [i];
  }
  for (let j = 0;j <= b.length; j++) {
    d[0][j] = j;
  }
  for (let j = 1;j <= b.length; j++) {
    for (let i = 1;i <= a.length; i++) {
      let cost;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
      } else {
        cost = 1;
      }
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}
function suggestSimilar(word, candidates) {
  if (!candidates || candidates.length === 0)
    return "";
  candidates = Array.from(new Set(candidates));
  const searchingOptions = word.startsWith("--");
  if (searchingOptions) {
    word = word.slice(2);
    candidates = candidates.map((candidate) => candidate.slice(2));
  }
  let similar = [];
  let bestDistance = maxDistance;
  const minSimilarity = 0.4;
  candidates.forEach((candidate) => {
    if (candidate.length <= 1)
      return;
    const distance = editDistance(word, candidate);
    const length = Math.max(word.length, candidate.length);
    const similarity = (length - distance) / length;
    if (similarity > minSimilarity) {
      if (distance < bestDistance) {
        bestDistance = distance;
        similar = [candidate];
      } else if (distance === bestDistance) {
        similar.push(candidate);
      }
    }
  });
  similar.sort((a, b) => a.localeCompare(b));
  if (searchingOptions) {
    similar = similar.map((candidate) => `--${candidate}`);
  }
  if (similar.length > 1) {
    return `
(Did you mean one of ${similar.join(", ")}?)`;
  }
  if (similar.length === 1) {
    return `
(Did you mean ${similar[0]}?)`;
  }
  return "";
}

// node_modules/.bun/commander@15.0.0/node_modules/commander/lib/command.js
class Command extends EventEmitter {
  constructor(name) {
    super();
    this.commands = [];
    this.options = [];
    this.parent = null;
    this._allowUnknownOption = false;
    this._allowExcessArguments = false;
    this.registeredArguments = [];
    this._args = this.registeredArguments;
    this.args = [];
    this.rawArgs = [];
    this.processedArgs = [];
    this._scriptPath = null;
    this._name = name || "";
    this._optionValues = {};
    this._optionValueSources = {};
    this._storeOptionsAsProperties = false;
    this._actionHandler = null;
    this._executableHandler = false;
    this._executableFile = null;
    this._executableDir = null;
    this._defaultCommandName = null;
    this._exitCallback = null;
    this._aliases = [];
    this._combineFlagAndOptionalValue = true;
    this._description = "";
    this._summary = "";
    this._argsDescription = undefined;
    this._enablePositionalOptions = false;
    this._passThroughOptions = false;
    this._lifeCycleHooks = {};
    this._showHelpAfterError = false;
    this._showSuggestionAfterError = true;
    this._savedState = null;
    this._outputConfiguration = {
      writeOut: (str) => process2.stdout.write(str),
      writeErr: (str) => process2.stderr.write(str),
      outputError: (str, write) => write(str),
      getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : undefined,
      getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : undefined,
      getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
      getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
      stripColor: (str) => stripVTControlCharacters2(str)
    };
    this._hidden = false;
    this._helpOption = undefined;
    this._addImplicitHelpCommand = undefined;
    this._helpCommand = undefined;
    this._helpConfiguration = {};
    this._helpGroupHeading = undefined;
    this._defaultCommandGroup = undefined;
    this._defaultOptionGroup = undefined;
  }
  copyInheritedSettings(sourceCommand) {
    this._outputConfiguration = sourceCommand._outputConfiguration;
    this._helpOption = sourceCommand._helpOption;
    this._helpCommand = sourceCommand._helpCommand;
    this._helpConfiguration = sourceCommand._helpConfiguration;
    this._exitCallback = sourceCommand._exitCallback;
    this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
    this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
    this._allowExcessArguments = sourceCommand._allowExcessArguments;
    this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
    this._showHelpAfterError = sourceCommand._showHelpAfterError;
    this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
    return this;
  }
  _getCommandAndAncestors() {
    const result = [];
    for (let command = this;command; command = command.parent) {
      result.push(command);
    }
    return result;
  }
  command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
    let desc = actionOptsOrExecDesc;
    let opts = execOpts;
    if (typeof desc === "object" && desc !== null) {
      opts = desc;
      desc = null;
    }
    opts = opts || {};
    const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
    const cmd = this.createCommand(name);
    if (desc) {
      cmd.description(desc);
      cmd._executableHandler = true;
    }
    if (opts.isDefault)
      this._defaultCommandName = cmd._name;
    cmd._hidden = !!(opts.noHelp || opts.hidden);
    cmd._executableFile = opts.executableFile || null;
    if (args)
      cmd.arguments(args);
    this._registerCommand(cmd);
    cmd.parent = this;
    cmd.copyInheritedSettings(this);
    if (desc)
      return this;
    return cmd;
  }
  createCommand(name) {
    return new Command(name);
  }
  createHelp() {
    return Object.assign(new Help, this.configureHelp());
  }
  configureHelp(configuration) {
    if (configuration === undefined)
      return this._helpConfiguration;
    this._helpConfiguration = configuration;
    return this;
  }
  configureOutput(configuration) {
    if (configuration === undefined)
      return this._outputConfiguration;
    this._outputConfiguration = {
      ...this._outputConfiguration,
      ...configuration
    };
    return this;
  }
  showHelpAfterError(displayHelp = true) {
    if (typeof displayHelp !== "string")
      displayHelp = !!displayHelp;
    this._showHelpAfterError = displayHelp;
    return this;
  }
  showSuggestionAfterError(displaySuggestion = true) {
    this._showSuggestionAfterError = !!displaySuggestion;
    return this;
  }
  addCommand(cmd, opts) {
    if (!cmd._name) {
      throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
    }
    opts = opts || {};
    if (opts.isDefault)
      this._defaultCommandName = cmd._name;
    if (opts.noHelp || opts.hidden)
      cmd._hidden = true;
    this._registerCommand(cmd);
    cmd.parent = this;
    cmd._checkForBrokenPassThrough();
    return this;
  }
  createArgument(name, description) {
    return new Argument(name, description);
  }
  argument(name, description, parseArg, defaultValue) {
    const argument = this.createArgument(name, description);
    if (typeof parseArg === "function") {
      argument.default(defaultValue).argParser(parseArg);
    } else {
      argument.default(parseArg);
    }
    this.addArgument(argument);
    return this;
  }
  arguments(names) {
    names.trim().split(/ +/).forEach((detail) => {
      this.argument(detail);
    });
    return this;
  }
  addArgument(argument) {
    const previousArgument = this.registeredArguments.slice(-1)[0];
    if (previousArgument?.variadic) {
      throw new Error(`only the last argument can be variadic '${previousArgument.name()}'`);
    }
    if (argument.required && argument.defaultValue !== undefined && argument.parseArg === undefined) {
      throw new Error(`a default value for a required argument is never used: '${argument.name()}'`);
    }
    this.registeredArguments.push(argument);
    return this;
  }
  helpCommand(enableOrNameAndArgs, description) {
    if (typeof enableOrNameAndArgs === "boolean") {
      this._addImplicitHelpCommand = enableOrNameAndArgs;
      if (enableOrNameAndArgs && this._defaultCommandGroup) {
        this._initCommandGroup(this._getHelpCommand());
      }
      return this;
    }
    const nameAndArgs = enableOrNameAndArgs ?? "help [command]";
    const [, helpName, helpArgs] = nameAndArgs.match(/([^ ]+) *(.*)/);
    const helpDescription = description ?? "display help for command";
    const helpCommand = this.createCommand(helpName);
    helpCommand.helpOption(false);
    if (helpArgs)
      helpCommand.arguments(helpArgs);
    if (helpDescription)
      helpCommand.description(helpDescription);
    this._addImplicitHelpCommand = true;
    this._helpCommand = helpCommand;
    if (enableOrNameAndArgs || description)
      this._initCommandGroup(helpCommand);
    return this;
  }
  addHelpCommand(helpCommand, deprecatedDescription) {
    if (typeof helpCommand !== "object") {
      this.helpCommand(helpCommand, deprecatedDescription);
      return this;
    }
    this._addImplicitHelpCommand = true;
    this._helpCommand = helpCommand;
    this._initCommandGroup(helpCommand);
    return this;
  }
  _getHelpCommand() {
    const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
    if (hasImplicitHelpCommand) {
      if (this._helpCommand === undefined) {
        this.helpCommand(undefined, undefined);
      }
      return this._helpCommand;
    }
    return null;
  }
  hook(event, listener) {
    const allowedValues = ["preSubcommand", "preAction", "postAction"];
    if (!allowedValues.includes(event)) {
      throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
    }
    if (this._lifeCycleHooks[event]) {
      this._lifeCycleHooks[event].push(listener);
    } else {
      this._lifeCycleHooks[event] = [listener];
    }
    return this;
  }
  exitOverride(fn) {
    if (fn) {
      this._exitCallback = fn;
    } else {
      this._exitCallback = (err) => {
        if (err.code !== "commander.executeSubCommandAsync") {
          throw err;
        }
      };
    }
    return this;
  }
  _exit(exitCode, code, message) {
    if (this._exitCallback) {
      this._exitCallback(new CommanderError(exitCode, code, message));
    }
    process2.exit(exitCode);
  }
  action(fn) {
    const listener = (args) => {
      const expectedArgsCount = this.registeredArguments.length;
      const actionArgs = args.slice(0, expectedArgsCount);
      if (this._storeOptionsAsProperties) {
        actionArgs[expectedArgsCount] = this;
      } else {
        actionArgs[expectedArgsCount] = this.opts();
      }
      actionArgs.push(this);
      return fn.apply(this, actionArgs);
    };
    this._actionHandler = listener;
    return this;
  }
  createOption(flags, description) {
    return new Option(flags, description);
  }
  _callParseArg(target, value, previous, invalidArgumentMessage) {
    try {
      return target.parseArg(value, previous);
    } catch (err) {
      if (err.code === "commander.invalidArgument") {
        const message = `${invalidArgumentMessage} ${err.message}`;
        this.error(message, { exitCode: err.exitCode, code: err.code });
      }
      throw err;
    }
  }
  _registerOption(option) {
    const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
    if (matchingOption) {
      const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
      throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
    }
    this._initOptionGroup(option);
    this.options.push(option);
  }
  _registerCommand(command) {
    const knownBy = (cmd) => {
      return [cmd.name()].concat(cmd.aliases());
    };
    const alreadyUsed = knownBy(command).find((name) => this._findCommand(name));
    if (alreadyUsed) {
      const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
      const newCmd = knownBy(command).join("|");
      throw new Error(`cannot add command '${newCmd}' as already have command '${existingCmd}'`);
    }
    this._initCommandGroup(command);
    this.commands.push(command);
  }
  addOption(option) {
    this._registerOption(option);
    const oname = option.name();
    const name = option.attributeName();
    if (option.defaultValue !== undefined) {
      this.setOptionValueWithSource(name, option.defaultValue, "default");
    }
    const handleOptionValue = (val, invalidValueMessage, valueSource) => {
      if (val == null && option.presetArg !== undefined) {
        val = option.presetArg;
      }
      const oldValue = this.getOptionValue(name);
      if (val !== null && option.parseArg) {
        val = this._callParseArg(option, val, oldValue, invalidValueMessage);
      } else if (val !== null && option.variadic) {
        val = option._collectValue(val, oldValue);
      }
      if (val == null) {
        if (option.negate) {
          val = false;
        } else if (option.isBoolean() || option.optional) {
          val = true;
        } else {
          val = "";
        }
      }
      this.setOptionValueWithSource(name, val, valueSource);
    };
    this.on("option:" + oname, (val) => {
      const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
      handleOptionValue(val, invalidValueMessage, "cli");
    });
    if (option.envVar) {
      this.on("optionEnv:" + oname, (val) => {
        const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, "env");
      });
    }
    return this;
  }
  _optionEx(config, flags, description, fn, defaultValue) {
    if (typeof flags === "object" && flags instanceof Option) {
      throw new Error("To add an Option object use addOption() instead of option() or requiredOption()");
    }
    const option = this.createOption(flags, description);
    option.makeOptionMandatory(!!config.mandatory);
    if (typeof fn === "function") {
      option.default(defaultValue).argParser(fn);
    } else if (fn instanceof RegExp) {
      const regex = fn;
      fn = (val, def) => {
        const m = regex.exec(val);
        return m ? m[0] : def;
      };
      option.default(defaultValue).argParser(fn);
    } else {
      option.default(fn);
    }
    return this.addOption(option);
  }
  option(flags, description, parseArg, defaultValue) {
    return this._optionEx({}, flags, description, parseArg, defaultValue);
  }
  requiredOption(flags, description, parseArg, defaultValue) {
    return this._optionEx({ mandatory: true }, flags, description, parseArg, defaultValue);
  }
  combineFlagAndOptionalValue(combine = true) {
    this._combineFlagAndOptionalValue = !!combine;
    return this;
  }
  allowUnknownOption(allowUnknown = true) {
    this._allowUnknownOption = !!allowUnknown;
    return this;
  }
  allowExcessArguments(allowExcess = true) {
    this._allowExcessArguments = !!allowExcess;
    return this;
  }
  enablePositionalOptions(positional = true) {
    this._enablePositionalOptions = !!positional;
    return this;
  }
  passThroughOptions(passThrough = true) {
    this._passThroughOptions = !!passThrough;
    this._checkForBrokenPassThrough();
    return this;
  }
  _checkForBrokenPassThrough() {
    if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
      throw new Error(`passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`);
    }
  }
  storeOptionsAsProperties(storeAsProperties = true) {
    if (this.options.length) {
      throw new Error("call .storeOptionsAsProperties() before adding options");
    }
    if (Object.keys(this._optionValues).length) {
      throw new Error("call .storeOptionsAsProperties() before setting option values");
    }
    this._storeOptionsAsProperties = !!storeAsProperties;
    return this;
  }
  getOptionValue(key) {
    if (this._storeOptionsAsProperties) {
      return this[key];
    }
    return this._optionValues[key];
  }
  setOptionValue(key, value) {
    return this.setOptionValueWithSource(key, value, undefined);
  }
  setOptionValueWithSource(key, value, source) {
    if (this._storeOptionsAsProperties) {
      this[key] = value;
    } else {
      this._optionValues[key] = value;
    }
    this._optionValueSources[key] = source;
    return this;
  }
  getOptionValueSource(key) {
    return this._optionValueSources[key];
  }
  getOptionValueSourceWithGlobals(key) {
    let source;
    this._getCommandAndAncestors().forEach((cmd) => {
      if (cmd.getOptionValueSource(key) !== undefined) {
        source = cmd.getOptionValueSource(key);
      }
    });
    return source;
  }
  _prepareUserArgs(argv, parseOptions) {
    if (argv !== undefined && !Array.isArray(argv)) {
      throw new Error("first parameter to parse must be array or undefined");
    }
    parseOptions = parseOptions || {};
    if (argv === undefined && parseOptions.from === undefined) {
      if (process2.versions?.electron) {
        parseOptions.from = "electron";
      }
      const execArgv = process2.execArgv ?? [];
      if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
        parseOptions.from = "eval";
      }
    }
    if (argv === undefined) {
      argv = process2.argv;
    }
    this.rawArgs = argv.slice();
    let userArgs;
    switch (parseOptions.from) {
      case undefined:
      case "node":
        this._scriptPath = argv[1];
        userArgs = argv.slice(2);
        break;
      case "electron":
        if (process2.defaultApp) {
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
        } else {
          userArgs = argv.slice(1);
        }
        break;
      case "user":
        userArgs = argv.slice(0);
        break;
      case "eval":
        userArgs = argv.slice(1);
        break;
      default:
        throw new Error(`unexpected parse option { from: '${parseOptions.from}' }`);
    }
    if (!this._name && this._scriptPath)
      this.nameFromFilename(this._scriptPath);
    this._name = this._name || "program";
    return userArgs;
  }
  parse(argv, parseOptions) {
    this._prepareForParse();
    const userArgs = this._prepareUserArgs(argv, parseOptions);
    this._parseCommand([], userArgs);
    return this;
  }
  async parseAsync(argv, parseOptions) {
    this._prepareForParse();
    const userArgs = this._prepareUserArgs(argv, parseOptions);
    await this._parseCommand([], userArgs);
    return this;
  }
  _prepareForParse() {
    if (this._savedState === null) {
      this.options.filter((option) => option.negate && option.defaultValue === undefined && this.getOptionValue(option.attributeName()) === undefined).forEach((option) => {
        const positiveLongFlag = option.long.replace(/^--no-/, "--");
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(option.attributeName(), true, "default");
        }
      });
      this.saveStateBeforeParse();
    } else {
      this.restoreStateBeforeParse();
    }
  }
  saveStateBeforeParse() {
    this._savedState = {
      _name: this._name,
      _optionValues: { ...this._optionValues },
      _optionValueSources: { ...this._optionValueSources }
    };
  }
  restoreStateBeforeParse() {
    if (this._storeOptionsAsProperties)
      throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
    this._name = this._savedState._name;
    this._scriptPath = null;
    this.rawArgs = [];
    this._optionValues = { ...this._savedState._optionValues };
    this._optionValueSources = { ...this._savedState._optionValueSources };
    this.args = [];
    this.processedArgs = [];
  }
  _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
    if (fs.existsSync(executableFile))
      return;
    const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
    const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
    throw new Error(executableMissing);
  }
  _executeSubCommand(subcommand, args) {
    args = args.slice();
    const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
    function findFile(baseDir, baseName) {
      const localBin = path.resolve(baseDir, baseName);
      if (fs.existsSync(localBin))
        return localBin;
      if (sourceExt.includes(path.extname(baseName)))
        return;
      const foundExt = sourceExt.find((ext) => fs.existsSync(`${localBin}${ext}`));
      if (foundExt)
        return `${localBin}${foundExt}`;
      return;
    }
    this._checkForMissingMandatoryOptions();
    this._checkForConflictingOptions();
    let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
    let executableDir = this._executableDir || "";
    if (this._scriptPath) {
      let resolvedScriptPath;
      try {
        resolvedScriptPath = fs.realpathSync(this._scriptPath);
      } catch {
        resolvedScriptPath = this._scriptPath;
      }
      executableDir = path.resolve(path.dirname(resolvedScriptPath), executableDir);
    }
    if (executableDir) {
      let localFile = findFile(executableDir, executableFile);
      if (!localFile && !subcommand._executableFile && this._scriptPath) {
        const legacyName = path.basename(this._scriptPath, path.extname(this._scriptPath));
        if (legacyName !== this._name) {
          localFile = findFile(executableDir, `${legacyName}-${subcommand._name}`);
        }
      }
      executableFile = localFile || executableFile;
    }
    const launchWithNode = sourceExt.includes(path.extname(executableFile));
    let proc;
    if (process2.platform !== "win32") {
      if (launchWithNode) {
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
      } else {
        proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
      }
    } else {
      this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
      args.unshift(executableFile);
      args = incrementNodeInspectorPort(process2.execArgv).concat(args);
      proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
    }
    if (!proc.killed) {
      const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
      signals.forEach((signal) => {
        process2.on(signal, () => {
          if (proc.killed === false && proc.exitCode === null) {
            proc.kill(signal);
          }
        });
      });
    }
    const exitCallback = this._exitCallback;
    proc.on("close", (code) => {
      code = code ?? 1;
      if (!exitCallback) {
        process2.exit(code);
      } else {
        exitCallback(new CommanderError(code, "commander.executeSubCommandAsync", "(close)"));
      }
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
      } else if (err.code === "EACCES") {
        throw new Error(`'${executableFile}' not executable`);
      }
      if (!exitCallback) {
        process2.exit(1);
      } else {
        const wrappedError = new CommanderError(1, "commander.executeSubCommandAsync", "(error)");
        wrappedError.nestedError = err;
        exitCallback(wrappedError);
      }
    });
    this.runningCommand = proc;
  }
  _dispatchSubcommand(commandName, operands, unknown) {
    const subCommand = this._findCommand(commandName);
    if (!subCommand)
      this.help({ error: true });
    subCommand._prepareForParse();
    let promiseChain;
    promiseChain = this._chainOrCallSubCommandHook(promiseChain, subCommand, "preSubcommand");
    promiseChain = this._chainOrCall(promiseChain, () => {
      if (subCommand._executableHandler) {
        this._executeSubCommand(subCommand, operands.concat(unknown));
      } else {
        return subCommand._parseCommand(operands, unknown);
      }
    });
    return promiseChain;
  }
  _dispatchHelpCommand(subcommandName) {
    if (!subcommandName) {
      this.help();
    }
    const subCommand = this._findCommand(subcommandName);
    if (subCommand && !subCommand._executableHandler) {
      subCommand.help();
    }
    return this._dispatchSubcommand(subcommandName, [], [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]);
  }
  _checkNumberOfArguments() {
    this.registeredArguments.forEach((arg, i) => {
      if (arg.required && this.args[i] == null) {
        this.missingArgument(arg.name());
      }
    });
    if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
      return;
    }
    if (this.args.length > this.registeredArguments.length) {
      this._excessArguments(this.args);
    }
  }
  _processArguments() {
    const myParseArg = (argument, value, previous) => {
      let parsedValue = value;
      if (value !== null && argument.parseArg) {
        const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
        parsedValue = this._callParseArg(argument, value, previous, invalidValueMessage);
      }
      return parsedValue;
    };
    this._checkNumberOfArguments();
    const processedArgs = [];
    this.registeredArguments.forEach((declaredArg, index) => {
      let value = declaredArg.defaultValue;
      if (declaredArg.variadic) {
        if (index < this.args.length) {
          value = this.args.slice(index);
          if (declaredArg.parseArg) {
            value = value.reduce((processed, v) => {
              return myParseArg(declaredArg, v, processed);
            }, declaredArg.defaultValue);
          }
        } else if (value === undefined) {
          value = [];
        }
      } else if (index < this.args.length) {
        value = this.args[index];
        if (declaredArg.parseArg) {
          value = myParseArg(declaredArg, value, declaredArg.defaultValue);
        }
      }
      processedArgs[index] = value;
    });
    this.processedArgs = processedArgs;
  }
  _chainOrCall(promise, fn) {
    if (promise?.then && typeof promise.then === "function") {
      return promise.then(() => fn());
    }
    return fn();
  }
  _chainOrCallHooks(promise, event) {
    let result = promise;
    const hooks = [];
    this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== undefined).forEach((hookedCommand) => {
      hookedCommand._lifeCycleHooks[event].forEach((callback) => {
        hooks.push({ hookedCommand, callback });
      });
    });
    if (event === "postAction") {
      hooks.reverse();
    }
    hooks.forEach((hookDetail) => {
      result = this._chainOrCall(result, () => {
        return hookDetail.callback(hookDetail.hookedCommand, this);
      });
    });
    return result;
  }
  _chainOrCallSubCommandHook(promise, subCommand, event) {
    let result = promise;
    if (this._lifeCycleHooks[event] !== undefined) {
      this._lifeCycleHooks[event].forEach((hook) => {
        result = this._chainOrCall(result, () => {
          return hook(this, subCommand);
        });
      });
    }
    return result;
  }
  _parseCommand(operands, unknown) {
    const parsed = this.parseOptions(unknown);
    this._parseOptionsEnv();
    this._parseOptionsImplied();
    operands = operands.concat(parsed.operands);
    unknown = parsed.unknown;
    this.args = operands.concat(unknown);
    if (operands && this._findCommand(operands[0])) {
      return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
    }
    if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
      return this._dispatchHelpCommand(operands[1]);
    }
    if (this._defaultCommandName) {
      this._outputHelpIfRequested(unknown);
      return this._dispatchSubcommand(this._defaultCommandName, operands, unknown);
    }
    if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
      this.help({ error: true });
    }
    this._outputHelpIfRequested(parsed.unknown);
    this._checkForMissingMandatoryOptions();
    this._checkForConflictingOptions();
    const checkForUnknownOptions = () => {
      if (parsed.unknown.length > 0) {
        this.unknownOption(parsed.unknown[0]);
      }
    };
    const commandEvent = `command:${this.name()}`;
    if (this._actionHandler) {
      checkForUnknownOptions();
      this._processArguments();
      let promiseChain;
      promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
      promiseChain = this._chainOrCall(promiseChain, () => this._actionHandler(this.processedArgs));
      if (this.parent) {
        promiseChain = this._chainOrCall(promiseChain, () => {
          this.parent.emit(commandEvent, operands, unknown);
        });
      }
      promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
      return promiseChain;
    }
    if (this.parent?.listenerCount(commandEvent)) {
      checkForUnknownOptions();
      this._processArguments();
      this.parent.emit(commandEvent, operands, unknown);
    } else if (operands.length) {
      if (this._findCommand("*")) {
        return this._dispatchSubcommand("*", operands, unknown);
      }
      if (this.listenerCount("command:*")) {
        this.emit("command:*", operands, unknown);
      } else if (this.commands.length) {
        this.unknownCommand();
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    } else if (this.commands.length) {
      checkForUnknownOptions();
      this.help({ error: true });
    } else {
      checkForUnknownOptions();
      this._processArguments();
    }
  }
  _findCommand(name) {
    if (!name)
      return;
    return this.commands.find((cmd) => cmd._name === name || cmd._aliases.includes(name));
  }
  _findOption(arg) {
    return this.options.find((option) => option.is(arg));
  }
  _checkForMissingMandatoryOptions() {
    this._getCommandAndAncestors().forEach((cmd) => {
      cmd.options.forEach((anOption) => {
        if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === undefined) {
          cmd.missingMandatoryOptionValue(anOption);
        }
      });
    });
  }
  _checkForConflictingLocalOptions() {
    const definedNonDefaultOptions = this.options.filter((option) => {
      const optionKey = option.attributeName();
      if (this.getOptionValue(optionKey) === undefined) {
        return false;
      }
      return this.getOptionValueSource(optionKey) !== "default";
    });
    const optionsWithConflicting = definedNonDefaultOptions.filter((option) => option.conflictsWith.length > 0);
    optionsWithConflicting.forEach((option) => {
      const conflictingAndDefined = definedNonDefaultOptions.find((defined) => option.conflictsWith.includes(defined.attributeName()));
      if (conflictingAndDefined) {
        this._conflictingOption(option, conflictingAndDefined);
      }
    });
  }
  _checkForConflictingOptions() {
    this._getCommandAndAncestors().forEach((cmd) => {
      cmd._checkForConflictingLocalOptions();
    });
  }
  parseOptions(args) {
    const operands = [];
    const unknown = [];
    let dest = operands;
    function maybeOption(arg) {
      return arg.length > 1 && arg[0] === "-";
    }
    const negativeNumberArg = (arg) => {
      if (!/^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg))
        return false;
      return !this._getCommandAndAncestors().some((cmd) => cmd.options.map((opt) => opt.short).some((short) => /^-\d$/.test(short)));
    };
    let activeVariadicOption = null;
    let activeGroup = null;
    let i = 0;
    while (i < args.length || activeGroup) {
      const arg = activeGroup ?? args[i++];
      activeGroup = null;
      if (arg === "--") {
        if (dest === unknown)
          dest.push(arg);
        dest.push(...args.slice(i));
        break;
      }
      if (activeVariadicOption && (!maybeOption(arg) || negativeNumberArg(arg))) {
        this.emit(`option:${activeVariadicOption.name()}`, arg);
        continue;
      }
      activeVariadicOption = null;
      if (maybeOption(arg)) {
        const option = this._findOption(arg);
        if (option) {
          if (option.required) {
            const value = args[i++];
            if (value === undefined)
              this.optionMissingArgument(option);
            this.emit(`option:${option.name()}`, value);
          } else if (option.optional) {
            let value = null;
            if (i < args.length && (!maybeOption(args[i]) || negativeNumberArg(args[i]))) {
              value = args[i++];
            }
            this.emit(`option:${option.name()}`, value);
          } else {
            this.emit(`option:${option.name()}`);
          }
          activeVariadicOption = option.variadic ? option : null;
          continue;
        }
      }
      if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
        const option = this._findOption(`-${arg[1]}`);
        if (option) {
          if (option.required || option.optional && this._combineFlagAndOptionalValue) {
            this.emit(`option:${option.name()}`, arg.slice(2));
          } else {
            this.emit(`option:${option.name()}`);
            activeGroup = `-${arg.slice(2)}`;
          }
          continue;
        }
      }
      if (/^--[^=]+=/.test(arg)) {
        const index = arg.indexOf("=");
        const option = this._findOption(arg.slice(0, index));
        if (option && (option.required || option.optional)) {
          this.emit(`option:${option.name()}`, arg.slice(index + 1));
          continue;
        }
      }
      if (dest === operands && maybeOption(arg) && !(this.commands.length === 0 && negativeNumberArg(arg))) {
        dest = unknown;
      }
      if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
        if (this._findCommand(arg)) {
          operands.push(arg);
          unknown.push(...args.slice(i));
          break;
        } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
          operands.push(arg, ...args.slice(i));
          break;
        } else if (this._defaultCommandName) {
          unknown.push(arg, ...args.slice(i));
          break;
        }
      }
      if (this._passThroughOptions) {
        dest.push(arg, ...args.slice(i));
        break;
      }
      dest.push(arg);
    }
    return { operands, unknown };
  }
  opts() {
    if (this._storeOptionsAsProperties) {
      const result = {};
      const len = this.options.length;
      for (let i = 0;i < len; i++) {
        const key = this.options[i].attributeName();
        result[key] = key === this._versionOptionName ? this._version : this[key];
      }
      return result;
    }
    return this._optionValues;
  }
  optsWithGlobals() {
    return this._getCommandAndAncestors().reduce((combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()), {});
  }
  error(message, errorOptions) {
    this._outputConfiguration.outputError(`${message}
`, this._outputConfiguration.writeErr);
    if (typeof this._showHelpAfterError === "string") {
      this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
    } else if (this._showHelpAfterError) {
      this._outputConfiguration.writeErr(`
`);
      this.outputHelp({ error: true });
    }
    const config = errorOptions || {};
    const exitCode = config.exitCode || 1;
    const code = config.code || "commander.error";
    this._exit(exitCode, code, message);
  }
  _parseOptionsEnv() {
    this.options.forEach((option) => {
      if (option.envVar && option.envVar in process2.env) {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === undefined || ["default", "config", "env"].includes(this.getOptionValueSource(optionKey))) {
          if (option.required || option.optional) {
            this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
          } else {
            this.emit(`optionEnv:${option.name()}`);
          }
        }
      }
    });
  }
  _parseOptionsImplied() {
    const dualHelper = new DualOptions(this.options);
    const hasCustomOptionValue = (optionKey) => {
      return this.getOptionValue(optionKey) !== undefined && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
    };
    this.options.filter((option) => option.implied !== undefined && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(this.getOptionValue(option.attributeName()), option)).forEach((option) => {
      Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
        this.setOptionValueWithSource(impliedKey, option.implied[impliedKey], "implied");
      });
    });
  }
  missingArgument(name) {
    const message = `error: missing required argument '${name}'`;
    this.error(message, { code: "commander.missingArgument" });
  }
  optionMissingArgument(option) {
    const message = `error: option '${option.flags}' argument missing`;
    this.error(message, { code: "commander.optionMissingArgument" });
  }
  missingMandatoryOptionValue(option) {
    const message = `error: required option '${option.flags}' not specified`;
    this.error(message, { code: "commander.missingMandatoryOptionValue" });
  }
  _conflictingOption(option, conflictingOption) {
    const findBestOptionFromValue = (option) => {
      const optionKey = option.attributeName();
      const optionValue = this.getOptionValue(optionKey);
      const negativeOption = this.options.find((target) => target.negate && optionKey === target.attributeName());
      const positiveOption = this.options.find((target) => !target.negate && optionKey === target.attributeName());
      if (negativeOption && (negativeOption.presetArg === undefined && optionValue === false || negativeOption.presetArg !== undefined && optionValue === negativeOption.presetArg)) {
        return negativeOption;
      }
      return positiveOption || option;
    };
    const getErrorMessage = (option) => {
      const bestOption = findBestOptionFromValue(option);
      const optionKey = bestOption.attributeName();
      const source = this.getOptionValueSource(optionKey);
      if (source === "env") {
        return `environment variable '${bestOption.envVar}'`;
      }
      return `option '${bestOption.flags}'`;
    };
    const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
    this.error(message, { code: "commander.conflictingOption" });
  }
  unknownOption(flag) {
    if (this._allowUnknownOption)
      return;
    let suggestion = "";
    if (flag.startsWith("--") && this._showSuggestionAfterError) {
      let candidateFlags = [];
      let command = this;
      do {
        const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
        candidateFlags = candidateFlags.concat(moreFlags);
        command = command.parent;
      } while (command && !command._enablePositionalOptions);
      suggestion = suggestSimilar(flag, candidateFlags);
    }
    const message = `error: unknown option '${flag}'${suggestion}`;
    this.error(message, { code: "commander.unknownOption" });
  }
  _excessArguments(receivedArgs) {
    if (this._allowExcessArguments)
      return;
    const expected = this.registeredArguments.length;
    const s = expected === 1 ? "" : "s";
    const received = receivedArgs.length;
    const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
    const details = receivedArgs.join(", ");
    const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${received}: ${details}.`;
    this.error(message, { code: "commander.excessArguments" });
  }
  unknownCommand() {
    const unknownName = this.args[0];
    let suggestion = "";
    if (this._showSuggestionAfterError) {
      const candidateNames = [];
      this.createHelp().visibleCommands(this).forEach((command) => {
        candidateNames.push(command.name());
        if (command.alias())
          candidateNames.push(command.alias());
      });
      suggestion = suggestSimilar(unknownName, candidateNames);
    }
    const message = `error: unknown command '${unknownName}'${suggestion}`;
    this.error(message, { code: "commander.unknownCommand" });
  }
  version(str, flags, description) {
    if (str === undefined)
      return this._version;
    this._version = str;
    flags = flags || "-V, --version";
    description = description || "output the version number";
    const versionOption = this.createOption(flags, description);
    this._versionOptionName = versionOption.attributeName();
    this._registerOption(versionOption);
    this.on("option:" + versionOption.name(), () => {
      this._outputConfiguration.writeOut(`${str}
`);
      this._exit(0, "commander.version", str);
    });
    return this;
  }
  description(str, argsDescription) {
    if (str === undefined && argsDescription === undefined)
      return this._description;
    this._description = str;
    if (argsDescription) {
      this._argsDescription = argsDescription;
    }
    return this;
  }
  summary(str) {
    if (str === undefined)
      return this._summary;
    this._summary = str;
    return this;
  }
  alias(alias) {
    if (alias === undefined)
      return this._aliases[0];
    let command = this;
    if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
      command = this.commands[this.commands.length - 1];
    }
    if (alias === command._name)
      throw new Error("Command alias can't be the same as its name");
    const matchingCommand = this.parent?._findCommand(alias);
    if (matchingCommand) {
      const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
      throw new Error(`cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`);
    }
    command._aliases.push(alias);
    return this;
  }
  aliases(aliases) {
    if (aliases === undefined)
      return this._aliases;
    aliases.forEach((alias) => this.alias(alias));
    return this;
  }
  usage(str) {
    if (str === undefined) {
      if (this._usage)
        return this._usage;
      const args = this.registeredArguments.map((arg) => {
        return humanReadableArgName(arg);
      });
      return [].concat(this.options.length || this._helpOption !== null ? "[options]" : [], this.commands.length ? "[command]" : [], this.registeredArguments.length ? args : []).join(" ");
    }
    this._usage = str;
    return this;
  }
  name(str) {
    if (str === undefined)
      return this._name;
    this._name = str;
    return this;
  }
  helpGroup(heading) {
    if (heading === undefined)
      return this._helpGroupHeading ?? "";
    this._helpGroupHeading = heading;
    return this;
  }
  commandsGroup(heading) {
    if (heading === undefined)
      return this._defaultCommandGroup ?? "";
    this._defaultCommandGroup = heading;
    return this;
  }
  optionsGroup(heading) {
    if (heading === undefined)
      return this._defaultOptionGroup ?? "";
    this._defaultOptionGroup = heading;
    return this;
  }
  _initOptionGroup(option) {
    if (this._defaultOptionGroup && !option.helpGroupHeading)
      option.helpGroup(this._defaultOptionGroup);
  }
  _initCommandGroup(cmd) {
    if (this._defaultCommandGroup && !cmd.helpGroup())
      cmd.helpGroup(this._defaultCommandGroup);
  }
  nameFromFilename(filename) {
    this._name = path.basename(filename, path.extname(filename));
    return this;
  }
  executableDir(path2) {
    if (path2 === undefined)
      return this._executableDir;
    this._executableDir = path2;
    return this;
  }
  helpInformation(contextOptions) {
    const helper = this.createHelp();
    const context = this._getOutputContext(contextOptions);
    helper.prepareContext({
      error: context.error,
      helpWidth: context.helpWidth,
      outputHasColors: context.hasColors
    });
    const text = helper.formatHelp(this, helper);
    if (context.hasColors)
      return text;
    return this._outputConfiguration.stripColor(text);
  }
  _getOutputContext(contextOptions) {
    contextOptions = contextOptions || {};
    const error = !!contextOptions.error;
    let baseWrite;
    let hasColors;
    let helpWidth;
    if (error) {
      baseWrite = (str) => this._outputConfiguration.writeErr(str);
      hasColors = this._outputConfiguration.getErrHasColors();
      helpWidth = this._outputConfiguration.getErrHelpWidth();
    } else {
      baseWrite = (str) => this._outputConfiguration.writeOut(str);
      hasColors = this._outputConfiguration.getOutHasColors();
      helpWidth = this._outputConfiguration.getOutHelpWidth();
    }
    const write = (str) => {
      if (!hasColors)
        str = this._outputConfiguration.stripColor(str);
      return baseWrite(str);
    };
    return { error, write, hasColors, helpWidth };
  }
  outputHelp(contextOptions) {
    let deprecatedCallback;
    if (typeof contextOptions === "function") {
      deprecatedCallback = contextOptions;
      contextOptions = undefined;
    }
    const outputContext = this._getOutputContext(contextOptions);
    const eventContext = {
      error: outputContext.error,
      write: outputContext.write,
      command: this
    };
    this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
    this.emit("beforeHelp", eventContext);
    let helpInformation = this.helpInformation({ error: outputContext.error });
    if (deprecatedCallback) {
      helpInformation = deprecatedCallback(helpInformation);
      if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
        throw new Error("outputHelp callback must return a string or a Buffer");
      }
    }
    outputContext.write(helpInformation);
    if (this._getHelpOption()?.long) {
      this.emit(this._getHelpOption().long);
    }
    this.emit("afterHelp", eventContext);
    this._getCommandAndAncestors().forEach((command) => command.emit("afterAllHelp", eventContext));
  }
  helpOption(flags, description) {
    if (typeof flags === "boolean") {
      if (flags) {
        if (this._helpOption === null)
          this._helpOption = undefined;
        if (this._defaultOptionGroup) {
          this._initOptionGroup(this._getHelpOption());
        }
      } else {
        this._helpOption = null;
      }
      return this;
    }
    this._helpOption = this.createOption(flags ?? "-h, --help", description ?? "display help for command");
    if (flags || description)
      this._initOptionGroup(this._helpOption);
    return this;
  }
  _getHelpOption() {
    if (this._helpOption === undefined) {
      this.helpOption(undefined, undefined);
    }
    return this._helpOption;
  }
  addHelpOption(option) {
    this._helpOption = option;
    this._initOptionGroup(option);
    return this;
  }
  help(contextOptions) {
    this.outputHelp(contextOptions);
    let exitCode = Number(process2.exitCode ?? 0);
    if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
      exitCode = 1;
    }
    this._exit(exitCode, "commander.help", "(outputHelp)");
  }
  addHelpText(position, text) {
    const allowedValues = ["beforeAll", "before", "after", "afterAll"];
    if (!allowedValues.includes(position)) {
      throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
    }
    const helpEvent = `${position}Help`;
    this.on(helpEvent, (context) => {
      let helpStr;
      if (typeof text === "function") {
        helpStr = text({ error: context.error, command: context.command });
      } else {
        helpStr = text;
      }
      if (helpStr) {
        context.write(`${helpStr}
`);
      }
    });
    return this;
  }
  _outputHelpIfRequested(args) {
    const helpOption = this._getHelpOption();
    const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
    if (helpRequested) {
      this.outputHelp();
      this._exit(0, "commander.helpDisplayed", "(outputHelp)");
    }
  }
}
function incrementNodeInspectorPort(args) {
  return args.map((arg) => {
    if (!arg.startsWith("--inspect")) {
      return arg;
    }
    let debugOption;
    let debugHost = "127.0.0.1";
    let debugPort = "9229";
    let match;
    if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
      debugOption = match[1];
    } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
      debugOption = match[1];
      if (/^\d+$/.test(match[3])) {
        debugPort = match[3];
      } else {
        debugHost = match[3];
      }
    } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
      debugOption = match[1];
      debugHost = match[3];
      debugPort = match[4];
    }
    if (debugOption && debugPort !== "0") {
      return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
    }
    return arg;
  });
}
function useColor() {
  if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
    return false;
  if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== undefined)
    return true;
  return;
}

// node_modules/.bun/commander@15.0.0/node_modules/commander/index.js
var program = new Command;

// packages/core/src/consts.ts
var RULE_START = "<!--loop-rules:start-->";
var RULE_END = "<!--loop-rules:end-->";
var ruleTag = (pattern) => `<!--rule:${pattern}-->`;
var ROLES = ["critic", "drafter", "judge"];
var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var isSlug = (s) => SLUG_RE.test(s) && s.length <= 64;
var WORLD_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
var SECTIONS = [
  "## What worked",
  "## What failed & why",
  "## Reusable lesson",
  "## Verification",
  "## Not verified"
];
var LOG_NAMES = ["hook", "worker", "web", "curriculum"];
// packages/core/src/errors.ts
class ConfigError extends Error {
  name = "ConfigError";
}

class ModelNotConfigured extends ConfigError {
  name = "ModelNotConfigured";
}

class LocalityViolation extends ConfigError {
  name = "LocalityViolation";
}

class ProviderError extends Error {
  name = "ProviderError";
}

class ProviderTimeout extends ProviderError {
  name = "ProviderTimeout";
}

class GitError extends Error {
  stderr;
  name = "GitError";
  constructor(message, stderr = "") {
    super(message);
    this.stderr = stderr;
  }
}

class ReviewError extends Error {
  name = "ReviewError";
}

class LockHeld extends Error {
  name = "LockHeld";
}

class ValidationError extends Error {
  name = "ValidationError";
}
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}

class Cached {
  constructor(getter) {
    this._getter = getter;
    this._value = undefined;
  }
  get value() {
    const getter = this._getter;
    if (getter !== undefined) {
      this._value = getter();
      this._getter = undefined;
    }
    return this._value;
  }
}
function cached(getter) {
  return new Cached(getter);
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function rawShape(def) {
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
  return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
  Object.defineProperty(target, key, {
    get() {
      const value = getter();
      assignProp(this, key, value);
      return value;
    },
    enumerable: true,
    configurable: true
  });
}
function putProp(target, key, value) {
  if (key in target)
    assignProp(target, key, value);
  else
    target[key] = value;
}
function mirrorShape(target, source, keys, wrap) {
  const raw = sourceShape(source);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc.enumerable)
      continue;
    if (desc.get) {
      deferProp(target, key, () => {
        const value = source._zod.def.shape[key];
        return wrap ? wrap(value, key) : value;
      });
    } else
      putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
  }
}
function mirrorProps(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (!desc.enumerable)
      continue;
    if (desc.get)
      deferProp(target, key, () => source[key]);
    else
      putProp(target, key, desc.value);
  }
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== undefined && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const newShape = {};
  mirrorShape(newShape, schema, maskedKeys(schema, mask));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function maskedKeys(schema, mask) {
  const raw = sourceShape(schema);
  const keys = [];
  for (const key of Reflect.ownKeys(mask)) {
    if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) {
      throw new Error(`Unrecognized key: "${String(key)}"`);
    }
    if (mask[key])
      keys.push(key);
  }
  return keys;
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const omitted = new Set(maskedKeys(schema, mask));
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = sourceShape(schema);
    for (const key of Reflect.ownKeys(shape)) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== undefined) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
  mirrorProps(newShape, shape);
  return newShape;
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
  if (!b?._zod?.def) {
    throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  }
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const newShape = {};
  mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
  mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
  const def = mergeDefs(a._zod.def, {
    shape: newShape,
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class, schema, mask, name = "partial") {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
  }
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({ type: "optional", innerType: value })));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape, checks: [] }));
}
function required(Class, schema, mask) {
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({ type: "nonoptional", innerType: value }));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function attachSchema(issues, start, inst) {
  var _a;
  for (let i = start;i < issues.length; i++) {
    (_a = issues[i]).schema ?? (_a.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config) {
  var _a;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a = iss).schema ?? (_a.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : undefined;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__")
      continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
  const units = str.length;
  if (!highSurrogate.test(str))
    return units;
  let count = units;
  for (let i = 0;i < units - 1; i++) {
    if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
function derived(computes, table) {
  for (const key in computes) {
    const compute = computes[key];
    Object.defineProperty(table, key, {
      configurable: true,
      enumerable: true,
      get() {
        return own(this, key, compute(this));
      },
      set(value) {
        own(this, key, value);
      }
    });
  }
  return table;
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? undefined : proto;
}
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return;
  }
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = undefined;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto)
    return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: undefined };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    }
  });
}
var CONSTANT_CATCH = "~constantCatch";
function constantCatch(value) {
  const fn = () => value;
  fn[CONSTANT_CATCH] = true;
  return fn;
}

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/core.js
var _a;
var _zodDesc = { value: undefined, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition;
      }
      try {
        return new Definition;
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition;
}
function $constructor(name, initializer, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = new Set;
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && new WeakSet;
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = undefined;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
    if (initialized) {
      const own = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto = _.prototype;
    for (const k in proto) {
      if (!Object.prototype.hasOwnProperty.call(proto, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = undefined;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true
};
var _issuesDesc = { value: undefined, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _issuesDesc.value = undefined;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = () => this.message;
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      }
    });
  }
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, undefined, {
  Parent: Error
});
function node(obj, key, make) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: make(), writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = make();
    }
  }
  return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue) => issue.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error, path = []) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (el === "_errors") {
              if (terminal)
                curr._errors.push(mapper(issue));
              i++;
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(curr, el)) {
              Object.defineProperty(curr, el, {
                value: { _errors: [] },
                enumerable: true,
                writable: true,
                configurable: true
              });
            }
            const node = curr[el];
            if (terminal) {
              node._errors.push(mapper(issue));
            }
            curr = node;
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
  return { callee: params?.callee ?? callee, Err: params?.Err };
}
var _parse = (_Err) => {
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError;
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _parseAsync = (_Err) => {
  const fn = async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise)
      result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
function failure(Err, issues, ctx) {
  let error;
  return {
    success: false,
    get error() {
      if (!error) {
        error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = undefined;
        ctx = undefined;
      }
      return error;
    },
    set error(e) {
      error = e;
      issues = undefined;
      ctx = undefined;
    }
  };
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
var COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
var COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
var validate = (schema, value, _ctx) => {
  const validator = schema._zod.bag.validator;
  if (validator !== undefined) {
    if (validator(value) !== COMPILE_INVALID)
      return true;
    if (validator.definite === true && _ctx === undefined)
      return false;
  }
  return validateFallback(schema, value, _ctx);
};
function validateFallback(schema, value, _ctx) {
  const ctx = _ctx ? { ..._ctx, async: false, abortEarly: true } : { async: false, abortEarly: true };
  const fallbackRun = schema._zod.bag.fallbackRun;
  let result;
  if (fallbackRun) {
    ctx[COMPILE_FALLBACK] = true;
    result = fallbackRun({ value, issues: [] }, ctx);
  } else {
    result = schema._zod.run({ value, issues: [] }, ctx);
  }
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length === 0;
}
var validateAsync = async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true, abortEarly: true } : { async: true, abortEarly: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length === 0;
};
var _encode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return parse(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    return parse(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _encodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/regexes.js
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
  return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
function anchor(source) {
  return new RegExp(`^${source}$`);
}
var date = /* @__PURE__ */ anchor(dateSource);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const opts = ["Z"];
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const qualified = `${timeSource({ precision: args.precision, seconds: true })}(?:${opts.join("|")})`;
  const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var anyString = /^[\s\S]{0,}$/;
var bigint = /^-?\d+n?$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var _whenHasLength = (payload) => {
  const val = payload.value;
  return !nullish(val) && val.length !== undefined;
};
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units > def.maximum ? codePointLength(input) : units;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = [], closed = {}) {
    this.content = [];
    this.indent = 0;
    this.args = args;
    this.closed = closed;
  }
  indented(fn) {
    this.indent += 1;
    try {
      fn(this);
    } finally {
      this.indent -= 1;
    }
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const content = this?.content ?? [``];
    const factory = new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {
${content.join(`
`)}
};`);
    return factory(...Object.values(this.closed));
  }
}

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 6,
  patch: 5
};

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const defChecks = inst._zod.def.checks;
  const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      if (payload.memo)
        return payload;
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          attachSchema(payload.issues, currLen, inst);
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
}, {
  get "~standard"() {
    return hide(this, "~standard", standardProps(this));
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  }
});
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync2(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
function standardProps(inst) {
  return {
    validate: (value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise))
          return toStandardResult(r, ctx);
      } catch (_) {}
      return validateAsync2(inst, value);
    },
    vendor: "zod",
    version: 1
  };
}
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = def.pattern ?? anyString;
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var URL_BAD_FORMAT = 1;
var URL_UNPARSEABLE = 2;
function canParseURL(input) {
  try {
    if (typeof URL !== "undefined" && typeof URL.canParse === "function")
      return URL.canParse(input);
    new URL(input);
    return true;
  } catch {
    return false;
  }
}
function validateURL(trimmed, def) {
  if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) {
    return canParseURL(trimmed) || URL_UNPARSEABLE;
  }
  return parseURLObject(trimmed, def);
}
function parseURLObject(trimmed, def) {
  if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) {
    return URL_BAD_FORMAT;
  }
  try {
    if (typeof URL !== "undefined") {
      const URLStatic = URL;
      if (typeof URLStatic.parse === "function")
        return URLStatic.parse(trimmed) ?? URL_UNPARSEABLE;
    }
    return new URL(trimmed);
  } catch {
    return URL_UNPARSEABLE;
  }
}
var asciiTabOrNewline = /[\t\n\r]/g;
function stripTabAndNewline(value) {
  return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
  hostname.lastIndex = 0;
  return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
  protocol.lastIndex = 0;
  return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = validateURL(trimmed, def);
      if (url === URL_BAD_FORMAT) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid URL format",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === URL_UNPARSEABLE) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === true) {
        payload.value = stripTabAndNewline(trimmed);
        return;
      }
      if (def.hostname && !urlHostnameOk(url, def.hostname)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid hostname",
          pattern: def.hostname.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      if (def.protocol && !urlProtocolOk(url, def.protocol)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid protocol",
          pattern: def.protocol.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  if (def.length !== undefined && (!Number.isInteger(def.length) || def.length < 1))
    throw new Error(`Invalid nanoid length: ${def.length}`);
  def.pattern ?? (def.pattern = def.length === undefined ? nanoid : nanoidOfLength(def.length));
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
});
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
  if (!ipv6Alphabet.test(value))
    return false;
  return canParseURL(`http://[${value}]`);
}
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidIPv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
  const parts = value.split("/");
  if (parts.length !== 2)
    return false;
  const [address, prefix] = parts;
  if (!prefix)
    return false;
  const prefixNum = Number(prefix);
  if (`${prefixNum}` !== prefix)
    return false;
  if (prefixNum < 0 || prefixNum > 128)
    return false;
  return isValidIPv6(address);
}
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidCIDRv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64Charset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
  if (!base64urlCharset.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64urlCharset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodBigInt = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = bigint;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = BigInt(payload.value);
      } catch (_) {}
    if (typeof payload.value === "bigint")
      return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodDate = /* @__PURE__ */ $constructor("$ZodDate", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value);
      } catch (_err) {}
    }
    const input = payload.value;
    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate)
      return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...isDate ? { received: "Invalid Date" } : {},
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    const abortEarly = ctx?.abortEarly;
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
        if (abortEarly && result.issues.length !== 0 && aborted(result))
          break;
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== undefined && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === undefined) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: undefined,
        path: [key]
      });
    }
    return;
  }
  if (result.value === undefined) {
    if (isPresent || optin === "defaulted" && !isOptionalOut) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    allKeys,
    symbolKeys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  let seen = 0;
  for (const key in input) {
    if (abortEarly && payload.issues.length !== seen) {
      if (aborted(payload, seen))
        break;
      seen = payload.issues.length;
    }
    if (keySet.has(key))
      continue;
    if (key === "__proto__") {
      if (t === "never")
        unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      continue: true
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  const sh = desc?.get ? desc.get.raw : def.shape ?? {};
  if (sh) {
    const get = () => {
      const newSh = { ...sh };
      Object.defineProperty(def, "shape", { value: newSh });
      get.raw = newSh;
      return newSh;
    };
    get.raw = sh;
    Object.defineProperty(def, "shape", { get });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazyInternal(inst, "propValues", (zod) => {
    const shape = zod.def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        if (!Object.prototype.hasOwnProperty.call(propValues, key)) {
          assignProp(propValues, key, new Set);
        }
        for (const v of field.values)
          propValues[key].add(v);
        if (field.optin !== undefined)
          propValues[key].add(undefined);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
    const proms = [];
    const shape = value.shape;
    const abortEarly = ctx?.abortEarly;
    let seen = payload.issues.length;
    for (const key of value.allKeys) {
      if (abortEarly && payload.issues.length !== seen) {
        if (aborted(payload, seen))
          break;
        seen = payload.issues.length;
      }
      if (key === "__proto__")
        continue;
      const el = shape[key];
      const optin = el._zod.optin;
      const optout = el._zod.optout;
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
      } else {
        handlePropertyResult(r, payload, key, input, optin, optout);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const memo = globalConfig.memoizer;
  const generateFastpass = (shape) => {
    const normalized = _normalized.value;
    const syms = normalized.symbolKeys;
    const doc = new Doc(["payload", "ctx"], { shape, inst, memo, syms });
    const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.allKeys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
    for (const key of normalized.allKeys) {
      if (key === "__proto__")
        continue;
      const id = ids[key];
      const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
      const isPresent = `${k} in input`;
      const schema = shape[key];
      const optin = schema?._zod?.optin;
      const isOptionalIn = optin !== undefined;
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(k)};`);
      if (isOptionalIn && isOptionalOut) {
        const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
        doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
        if (optin === "defaulted") {
          doc.write(`newResult[${k}] = ${id}.value;`);
        } else {
          doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
        }
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    return doc.compile();
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== undefined) ? "optional" : undefined);
  defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    if (Object.prototype.hasOwnProperty.call(newObj, "__proto__"))
      delete newObj.__proto__;
    for (const key of sharedKeys) {
      if (key === "__proto__")
        continue;
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = new Map;
  let unrecIssue;
  const keyIssues = new Map;
  const collect = (iss, side) => {
    let keys;
    if (iss.code === "unrecognized_keys" && !iss.path?.length) {
      unrecIssue ?? (unrecIssue = iss);
      keys = iss.keys;
    } else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
      const k = String(iss.path[0]);
      if (!keyIssues.has(k))
        keyIssues.set(k, iss);
      keys = [k];
    } else {
      return false;
    }
    for (const k of keys) {
      if (!unrecKeys.has(k))
        unrecKeys.set(k, {});
      unrecKeys.get(k)[side] = true;
    }
    return true;
  };
  for (const iss of left.issues) {
    if (!collect(iss, "l"))
      result.issues.push(iss);
  }
  for (const iss of right.issues) {
    if (!collect(iss, "r"))
      result.issues.push(iss);
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length) {
    const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
    if (aggregated.length)
      result.issues.push({ ...unrecIssue, keys: aggregated });
    for (const k of bothKeys) {
      if (!aggregated.includes(k) && keyIssues.has(k))
        result.issues.push(keyIssues.get(k));
    }
  }
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    if (aborted(result))
      return result;
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values && !def.partial) {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      const recordKeys = new Set;
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          if (key === "__proto__")
            continue;
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
            continue;
          }
          const outKey = keyResult.value;
          if (outKey === "__proto__")
            continue;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result) => {
              if (result.issues.length) {
                payload.issues.push(...prefixIssues(key, result.issues));
              }
              payload.value[outKey] = result.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (def.mode === "loose") {
            if (key === "__proto__")
              continue;
            payload.value[key] = input[key];
          } else {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    } else {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      let unrecognized;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key))
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else if (values) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const outKey = keyResult.value;
        if (outKey === "__proto__")
          continue;
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result) => {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[outKey] = result.value;
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  defineLazyInternal(inst, "pattern", (zod) => {
    const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
    return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const values = new Set(def.values);
  inst._zod.values = values;
  defineLazyInternal(inst, "pattern", (zod) => {
    const vals = zod.def.values;
    return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  globalConfig.memoizer?.guard(inst);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? undefined : result.value;
  return payload;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  inst._zod.optout = "optional";
  defineLazyInternal(inst, "values", (zod) => {
    const values = zod.def.innerType._zod.values;
    return values ? new Set([...values, undefined]) : undefined;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === undefined) {
      if (def.innerType._zod.optin !== "defaulted")
        return payload;
      const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
      if (result instanceof Promise)
        return result.then((result) => handleOptionalResult(payload, result));
      return handleOptionalResult(payload, result);
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazyInternal(inst, "values", (zod) => {
    return zod.def.innerType._zod.values ? new Set([...zod.def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => {
    const v = zod.def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
function handleCatchResult(payload, result, def, ctx) {
  if (!result.issues.length) {
    payload.value = result.value;
    if (result.memo)
      payload.memo = true;
    return payload;
  }
  payload.value = def.catchValue({
    ...result,
    value: payload.value,
    error: {
      issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
    },
    input: payload.value
  });
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleCatchResult(payload, result, def, ctx));
    }
    return handleCatchResult(payload, result, def, ctx);
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  if (!payload.memo)
    payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/memoizer.js
class $ZodCyclicError extends Error {
  constructor() {
    super(`Cannot parse a reference cycle that closes through a transform`);
    this.name = "ZodCyclicError";
  }
}
var STATE = "~memo";
var NO_ISSUES = [];
function isRef(value) {
  return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
  return issues.map((iss) => iss.path ? { ...iss, path: iss.path.slice() } : { ...iss });
}
var recursive = /* @__PURE__ */ new WeakMap;
var NONE = 0;
var ASSUMED = 1;
var PROVEN = 2;
function isRecursive(inst, stack, resolve) {
  const cached = recursive.get(inst);
  if (cached !== undefined)
    return cached ? PROVEN : NONE;
  if (stack.has(inst))
    return PROVEN;
  stack.add(inst);
  let result = NONE;
  const check = (child) => {
    if (result !== PROVEN && child?._zod) {
      const answer = isRecursive(child, stack, resolve);
      if (answer > result)
        result = answer;
    }
  };
  const shape = (sh, spread) => {
    let answer = NONE;
    for (const key of Reflect.ownKeys(sh)) {
      const desc = Object.getOwnPropertyDescriptor(sh, key);
      if (spread && !desc.enumerable)
        continue;
      const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
      if (child > answer)
        answer = child;
    }
    return answer;
  };
  const merge = (answer) => {
    if (answer > result)
      result = answer;
  };
  const def = inst._zod.def;
  const kind = def.type;
  switch (kind) {
    case "object": {
      const raw = rawShape(def);
      merge(raw ? shape(raw, true) : ASSUMED);
      check(def.catchall);
      break;
    }
    case "array":
      check(def.element);
      break;
    case "tuple":
      for (const el of def.items)
        check(el);
      check(def.rest);
      break;
    case "record":
    case "map":
      check(def.keyType);
      check(def.valueType);
      break;
    case "set":
      check(def.valueType);
      break;
    case "union":
      for (const el of def.options)
        check(el);
      break;
    case "intersection":
      check(def.left);
      check(def.right);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "promise":
    case "success":
      check(def.innerType);
      break;
    case "pipe":
      check(def.in);
      check(def.out);
      break;
    case "function":
      check(def.input);
      check(def.output);
      break;
    case "lazy": {
      const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : undefined);
      merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
      break;
    }
    case "template_literal":
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "date":
    case "nan":
    case "enum":
    case "literal":
    case "file":
    case "transform":
    case "custom":
      break;
    default: {
      for (const key in def) {
        const desc = Object.getOwnPropertyDescriptor(def, key);
        if (!desc || desc.get)
          continue;
        const value = desc.value;
        if (!value || typeof value !== "object")
          continue;
        if (value._zod)
          check(value);
        else if (Array.isArray(value))
          for (const el of value)
            check(el);
      }
    }
  }
  stack.delete(inst);
  return settle(inst, result);
}
function settle(inst, answer) {
  if (answer !== ASSUMED)
    recursive.set(inst, answer === PROVEN);
  return answer;
}
function bucketFor(state, inst) {
  let bucket = state.buckets.get(inst);
  if (!bucket) {
    bucket = new WeakMap;
    state.buckets.set(inst, bucket);
  }
  return bucket;
}
var handoff;
var open = [];
var memo = {
  alloc(_inst, payload, empty) {
    const bucket = handoff;
    if (!bucket)
      return empty;
    handoff = undefined;
    const entry = { value: empty, issues: null };
    bucket.set(payload.value, entry);
    open.push(entry);
    return empty;
  },
  guard(inst) {
    var _a;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value))
          throw new $ZodCyclicError;
        return base(payload, ctx);
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  },
  attach(inst) {
    var _a;
    let isRecursiveInst;
    let rechecked = false;
    let lastCtx;
    let lastBucket;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (isRecursiveInst === undefined) {
          const walked = isRecursive(inst, new Set, false);
          if (walked === NONE) {
            inst._zod.parse = base;
            if (inst._zod.run === wrapped)
              inst._zod.run = base;
            return base(payload, ctx);
          }
          if (walked === PROVEN || rechecked)
            isRecursiveInst = true;
          else
            rechecked = true;
        }
        const input = payload.value;
        if (!isRef(input))
          return base(payload, ctx);
        let state = ctx[STATE];
        if (!state) {
          state = { buckets: new WeakMap, backEdges: undefined };
          ctx[STATE] = state;
        }
        let bucket;
        if (lastCtx === ctx) {
          bucket = lastBucket;
        } else {
          bucket = bucketFor(state, inst);
          lastCtx = ctx;
          lastBucket = bucket;
        }
        const hit = bucket.get(input);
        if (hit) {
          payload.value = hit.value;
          if (hit.issues) {
            if (hit.issues.length)
              payload.issues.push(...cloneIssues(hit.issues));
          } else {
            payload.memo = true;
            state.backEdges ?? (state.backEdges = new WeakSet);
            state.backEdges.add(hit.value);
          }
          return payload;
        }
        handoff = bucket;
        const depth = open.length;
        const result = base(payload, ctx);
        handoff = undefined;
        const entry = open.length > depth ? open.pop() : undefined;
        if (result instanceof Promise) {
          return result.then((r) => {
            if (entry)
              entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
            return r;
          });
        }
        if (entry)
          entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
        return result;
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  }
};
function memoizer() {
  return memo;
}
function isBackEdge(ctx, value) {
  const backEdges = ctx[STATE]?.backEdges;
  return backEdges !== undefined && isRef(value) && backEdges.has(value);
}
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/locales/en.js
var error = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
    map: { unit: "entries", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    mac: "MAC address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    currency_code: "currency code",
    credit_card: "credit card number",
    iban: "IBAN",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  function getTypeName(type, input) {
    if (type === "number" && typeof input === "number" && !Number.isFinite(input)) {
      return String(input);
    }
    return TypeDictionary[type] ?? type;
  }
  return (issue) => {
    switch (issue.code) {
      case "invalid_type": {
        const expected = getTypeName(issue.expected);
        const receivedType = parsedType(issue.input);
        const received = getTypeName(receivedType, issue.input);
        return `Invalid input: expected ${expected}, received ${received}`;
      }
      case "invalid_value":
        if (issue.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue.origin}`;
      case "invalid_union":
        if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) {
          const opts = issue.options.map((o) => `'${o}'`).join(" | ");
          return `Invalid discriminator value. Expected ${opts}`;
        }
        if (issue.inclusive === false) {
          return "Invalid input: more than one option matched";
        }
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error()
  };
}
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/registries.js
var _a2;
class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
  if (def.checks)
    def.checks = [...def.checks];
  return def;
}
function _string(Class, params) {
  return new Class(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
function _coercedString(Class, params) {
  return new Class(snapshotChecks({ type: "string", coerce: true, ...normalizeParams(params) }));
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
function _coercedNumber(Class, params) {
  return new Class(snapshotChecks({ type: "number", coerce: true, checks: [], ...normalizeParams(params) }));
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _coercedBoolean(Class, params) {
  return new Class({
    type: "boolean",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _coercedBigint(Class, params) {
  return new Class({
    type: "bigint",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _coercedDate(Class, params) {
  return new Class({
    type: "date",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _slugify() {
  return _overwrite((input) => slugify(input));
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn, params) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
  for (const source of sources) {
    for (const key of Reflect.ownKeys(source)) {
      if (Object.prototype.propertyIsEnumerable.call(source, key)) {
        assignProp(target, key, source[key]);
      }
    }
  }
  return target;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map,
    sharedDefsExtractedFor: undefined,
    sharedEmitDoneFor: undefined,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    intersections: [],
    deferred: [],
    external: params?.external ?? undefined
  };
}
function handleUnrepresentable(schema, ctx, json, params, message) {
  const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({ zodSchema: schema, path: params.path, message }) : ctx.unrepresentable;
  if (result === "any")
    return false;
  if (result === undefined || result === "throw")
    throw new Error(message);
  Object.assign(json, result);
  return true;
}
function processSchema(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  ctx.sharedDefsExtractedFor = undefined;
  ctx.sharedEmitDoneFor = undefined;
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      processSchema(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    assignProps(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a = result.schema).default ?? (_a.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function encodeJSONPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external)
    return;
  const idToSchema = new Map;
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id) => id);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}` };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    if (entry[1] === root && !entry[1].schema.id) {
      return { ref: uriPrefix };
    }
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + encodeJSONPointerSegment(defId) };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) {
      delete schema[key];
    }
    schema.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
      }
    }
  }
  if (ctx.external)
    ctx.sharedDefsExtractedFor = ctx.external;
}
function compactTypeUnion(schema) {
  const options = schema.anyOf;
  if (!Array.isArray(options) || options.length === 0 || schema.type !== undefined)
    return;
  const types = [];
  for (const option of options) {
    if (!option || typeof option !== "object")
      return;
    compactTypeUnion(option);
    const keys = Object.keys(option);
    if (keys.length !== 1 || keys[0] !== "type")
      return;
    const type = option.type;
    for (const member of Array.isArray(type) ? type : [type]) {
      if (typeof member !== "string")
        return;
      if (!types.includes(member))
        types.push(member);
    }
  }
  delete schema.anyOf;
  schema.type = types.length === 1 ? types[0] : types;
}
var FOLDABLE_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
var UNION_KEYS = ["oneOf", "anyOf"];
function undeclaredConstraint(member) {
  const extra = member.additionalProperties;
  if (extra === undefined || extra === false || typeof extra !== "object" || extra === null)
    return null;
  return Object.keys(extra).length ? extra : null;
}
function foldObjects(members) {
  const objects = [];
  for (const member of members) {
    if (typeof member !== "object" || member.type !== "object")
      return null;
    for (const key in member) {
      if (!FOLDABLE_KEYS.has(key))
        return null;
    }
    objects.push(member);
  }
  const properties = {};
  const required = new Set;
  for (const object of objects) {
    for (const key in object.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key))
        continue;
      const parts = [];
      for (const other of objects) {
        const part = other.properties?.[key] ?? undeclaredConstraint(other);
        if (part === null || part === undefined)
          continue;
        if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part)))
          parts.push(part);
      }
      const merged = parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts };
      assignProp(properties, key, merged);
    }
    for (const key of object.required ?? [])
      required.add(key);
  }
  const folded = { type: "object", properties };
  if (required.size)
    folded.required = [...required];
  if (objects.every((object) => object.additionalProperties === false)) {
    folded.additionalProperties = false;
  } else {
    const constraints = [];
    for (const object of objects) {
      const constraint = undeclaredConstraint(object);
      if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint)))
        constraints.push(constraint);
    }
    if (constraints.length === 1)
      folded.additionalProperties = constraints[0];
    else if (constraints.length > 1)
      folded.additionalProperties = { allOf: constraints };
  }
  return folded;
}
function foldIntersection(json) {
  const allOf = json.allOf;
  if (!Array.isArray(allOf) || allOf.length < 2)
    return;
  for (const key of FOLDABLE_KEYS)
    if (key in json)
      return;
  const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
  let folded = null;
  if (!unions.length) {
    folded = foldObjects(allOf);
  } else {
    const union = unions[0];
    const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
    if (Object.keys(union).length !== 1)
      return;
    const rest = allOf.filter((m) => m !== union);
    const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
    if (branches.some((b) => !b))
      return;
    folded = { [keyword]: branches };
  }
  if (!folded)
    return;
  delete json.allOf;
  assignProps(json, folded);
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        assignProps(schema, refSchema);
      }
      assignProps(schema, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema,
      path: seen.path ?? []
    });
  };
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of [...ctx.seen.entries()].reverse()) {
      flattenRef(entry[0]);
    }
    if (ctx.target !== "openapi-3.0") {
      for (const entry of ctx.seen.entries()) {
        compactTypeUnion(entry[1].def ?? entry[1].schema);
      }
    }
    for (const rewrite of ctx.deferred)
      rewrite();
    if (ctx.intersections.length) {
      const carriers = new Map;
      for (const seen of ctx.seen.values()) {
        for (const json of [seen.schema, seen.def]) {
          const allOf = json?.allOf;
          if (!Array.isArray(allOf))
            continue;
          const existing = carriers.get(allOf);
          if (existing)
            existing.push(json);
          else
            carriers.set(allOf, [json]);
        }
      }
      for (const allOf of ctx.intersections) {
        for (const json of carriers.get(allOf) ?? [])
          foldIntersection(json);
      }
    }
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {}
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        if (seen.def.id === seen.defId)
          delete seen.def.id;
        assignProp(defs, seen.defId, seen.def);
      }
    }
  }
  if (ctx.external)
    ctx.sharedEmitDoneFor = ctx.external;
  if (ctx.external) {} else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/core/json-schema-processors.js
var narrowMin = (agg, key, value) => {
  if (agg[key] === undefined || value > agg[key])
    agg[key] = value;
};
var narrowMax = (agg, key, value) => {
  if (agg[key] === undefined || value < agg[key])
    agg[key] = value;
};
var narrowBoth = (agg, value) => {
  narrowMin(agg, "minimum", value);
  narrowMax(agg, "maximum", value);
};
var addDivisor = (agg, value) => {
  agg.multipleOf ?? (agg.multipleOf = []);
  if (!agg.multipleOf.includes(value))
    agg.multipleOf.push(value);
};
var addPattern = (agg, pattern) => {
  agg.patterns ?? (agg.patterns = new Set);
  agg.patterns.add(pattern);
};
var intersectMime = (agg, mime) => {
  agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
var setFormat = (agg, format) => {
  agg.format = format;
  if (format.includes("int"))
    agg.isInt = true;
};
var minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
var maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
var formatContributor = (ranges) => (agg, def) => {
  setFormat(agg, def.format);
  const [minimum, maximum] = ranges[def.format];
  narrowMin(agg, "minimum", minimum);
  narrowMax(agg, "maximum", maximum);
};
var contributors = {
  greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
  less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
  multiple_of: (agg, def) => addDivisor(agg, def.value),
  number_format: formatContributor(NUMBER_FORMAT_RANGES),
  bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
  min_length: minContributor,
  max_length: maxContributor,
  length_equals: (agg, def) => narrowBoth(agg, def.length),
  min_size: minContributor,
  max_size: maxContributor,
  size_equals: (agg, def) => narrowBoth(agg, def.size),
  string_format: (agg, def) => {
    setFormat(agg, def.format);
    if (def.pattern)
      addPattern(agg, def.pattern);
    if (def.format === "base64" || def.format === "base64url")
      agg.contentEncoding = def.format;
    if (def.local || def.precision === -1)
      agg.laxFormat = true;
  },
  mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
  const agg = {};
  const def = schema._zod.def;
  const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
  for (const ch of list)
    contributors[ch._zod.def.check]?.(agg, ch._zod.def);
  const bag = schema._zod.bag;
  if (bag.minimum !== undefined)
    narrowMin(agg, "minimum", bag.minimum);
  if (bag.exclusiveMinimum !== undefined)
    narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
  if (bag.maximum !== undefined)
    narrowMax(agg, "maximum", bag.maximum);
  if (bag.exclusiveMaximum !== undefined)
    narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
  if (bag.multipleOf !== undefined)
    addDivisor(agg, bag.multipleOf);
  if (bag.format !== undefined) {
    agg.format ?? (agg.format = bag.format);
    if (bag.format.includes("int"))
      agg.isInt = true;
  }
  if (bag.mime)
    intersectMime(agg, bag.mime);
  for (const pattern of bag.patterns ?? [])
    addPattern(agg, pattern);
  return agg;
}
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
};
var exactPatterns = new Map([
  [base64Charset, base64],
  [base64urlCharset, base64url]
]);
var exactPattern = (p) => exactPatterns.get(p) ?? p;
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time" || laxFormat) {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const patternList = [...patterns].map(exactPattern);
    if (patternList.length === 1)
      json.pattern = patternList[0].source;
    else if (patternList.length > 1) {
      json.allOf = [
        ...patternList.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
  json.type = isInt ? "integer" : "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (multipleOf) {
    const divisors = new Set;
    for (const divisor of multipleOf) {
      if (Number.isFinite(divisor) && divisor !== 0)
        divisors.add(Math.abs(divisor));
      else
        handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
    }
    const [first, ...rest] = divisors;
    if (first !== undefined)
      json.multipleOf = first;
    if (rest.length)
      json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
  }
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var bigintProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "BigInt cannot be represented in JSON Schema");
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var unknownProcessor = (_schema, _ctx, _json, _params) => {};
var dateProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Date cannot be represented in JSON Schema");
};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.length === 0) {
    json.not = {};
    return;
  }
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  if (def.values.length === 0) {
    json.not = {};
    return;
  }
  const vals = [];
  for (const val of def.values) {
    if (val === undefined) {
      if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema"))
        return;
    } else if (typeof val === "bigint") {
      if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema"))
        return;
      vals.push(Number(val));
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {} else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var customProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = processSchema(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
function inputOptin(schema) {
  const def = schema._zod.def;
  if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) {
    return inputOptin(def.out);
  }
  if (def.type === "catch") {
    return inputOptin(def.innerType);
  }
  return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const shape = def.shape;
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  if (symbolKeys.length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) {
    return;
  }
  json.type = "object";
  json.properties = {};
  for (const key in shape) {
    assignProp(json.properties, key, processSchema(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    }));
  }
  const requiredKeys = [];
  for (const key of Object.keys(shape)) {
    const field = def.shape[key];
    if (ctx.io === "input" ? inputOptin(field) === undefined : field._zod.optout === undefined) {
      requiredKeys.push(key);
    }
  }
  if (requiredKeys.length > 0) {
    json.required = requiredKeys;
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = processSchema(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => processSchema(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = processSchema(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = processSchema(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
  ctx.intersections.push(allOf);
};
function stringifyKeyNames(bySchema, json, visited) {
  if (json.$ref) {
    if (visited.has(json))
      return json;
    visited.add(json);
    const def = bySchema.get(json)?.def;
    if (!def)
      return json;
    const inlined = stringifyKeyNames(bySchema, def, visited);
    return inlined === def ? json : inlined;
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = json[keyword];
    if (!Array.isArray(branches))
      continue;
    const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
    if (mapped.some((branch, i) => branch !== branches[i]))
      json = { ...json, [keyword]: mapped };
  }
  const types = Array.isArray(json.type) ? json.type : [json.type];
  const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
  const values = json.enum ?? (json.const !== undefined ? [json.const] : undefined);
  if (!numericType && !values?.some((v) => typeof v === "number"))
    return json;
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
  if (rest.enum)
    rest.enum = rest.enum.map((v) => typeof v === "number" ? String(v) : v);
  else if (typeof rest.const === "number")
    rest.const = String(rest.const);
  if (!numericType)
    return rest;
  rest.type = "string";
  if (!values)
    rest.pattern = (types.includes("number") ? number : integer).source;
  return rest;
}
var pendingRecords = new WeakMap;
function rewriteKeyNames(ctx) {
  const bySchema = new Map;
  for (const entry of ctx.seen.values()) {
    if (entry.def && !bySchema.has(entry.schema))
      bySchema.set(entry.schema, entry);
  }
  const rewrites = new Map;
  for (const record of pendingRecords.get(ctx) ?? []) {
    const seen = ctx.seen.get(record);
    const names = (seen?.def ?? seen?.schema)?.propertyNames;
    if (!names || names === true || rewrites.has(names))
      continue;
    const rewritten = stringifyKeyNames(bySchema, names, new Set);
    if (rewritten !== names)
      rewrites.set(names, rewritten);
  }
  if (!rewrites.size)
    return;
  for (const entry of ctx.seen.values()) {
    for (const carrier of [entry.schema, entry.def]) {
      const rewritten = carrier && rewrites.get(carrier.propertyNames);
      if (rewritten)
        carrier.propertyNames = rewritten;
    }
  }
}
var recordProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  const keyType = def.keyType;
  const patterns = aggregateChecks(keyType).patterns;
  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "patternProperties", "*"]
    });
    json.patternProperties = {};
    for (const pattern of patterns) {
      assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
    }
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json.propertyNames = processSchema(def.keyType, ctx, {
        ...params,
        path: [...params.path, "propertyNames"]
      });
      let pending = pendingRecords.get(ctx);
      if (!pending) {
        pending = [];
        pendingRecords.set(ctx, pending);
        ctx.deferred.push(() => rewriteKeyNames(ctx));
      }
      pending.push(schema);
    }
    json.additionalProperties = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
  const keyValues = keyType._zod.values;
  const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== undefined;
  if (keyValues && !def.partial && !omittableOnInput) {
    const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) {
      json.required = validKeyValues.map(String);
    }
  }
};
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
  let unrepresentable = false;
  const serialized = JSON.stringify(value, (_, val) => {
    if (typeof val !== "bigint")
      return val;
    unrepresentable = true;
    return null;
  });
  if (!unrepresentable)
    return JSON.parse(serialized);
  handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
  return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io !== "input")
    return;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(undefined);
  } catch {
    handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
    return;
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  processSchema(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: false,
    get() {
      const value = make(this);
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
      return value;
    },
    set(value) {
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
    }
  });
}
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  const proto = Object.getPrototypeOf(inst);
  if (_installedErrorProtos.has(proto))
    return;
  _installedErrorProtos.add(proto);
  _lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
  _lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
  _lazyMethod(proto, "addIssue", (self) => (issue) => {
    self.issues.push(issue);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  _lazyMethod(proto, "addIssues", (self) => (issues) => {
    self.issues.push(...issues);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  Object.defineProperty(proto, "isEmpty", {
    configurable: true,
    enumerable: false,
    get() {
      return this.issues.length === 0;
    }
  });
};
var ZodError = /* @__PURE__ */ $constructor("ZodError", initializer2);
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, undefined, {
  Parent: Error
});

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
  if (!globalConfig.localeError)
    config(en_default());
}
function _ensureDefaultMemoizer() {
  if (!globalConfig.memoizer)
    config({ memoizer: memoizer() });
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  _ensureDefaultLocale();
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  return inst;
}, {
  check(...chks) {
    const def = this.def;
    return this.clone(mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }), { parent: true });
  },
  with(...chks) {
    return this.check(...chks);
  },
  clone(def, params) {
    return clone(this, def, params);
  },
  brand() {
    return this;
  },
  register(reg, meta) {
    reg.add(this, meta);
    return this;
  },
  refine(check, params) {
    return this.check(refine(check, params));
  },
  superRefine(refinement, params) {
    return this.check(superRefine(refinement, params));
  },
  overwrite(fn) {
    return this.check(_overwrite(fn));
  },
  optional() {
    return optional(this);
  },
  exactOptional() {
    return exactOptional(this);
  },
  nullable() {
    return nullable(this);
  },
  nullish() {
    return optional(nullable(this));
  },
  nonoptional(params) {
    return nonoptional(this, params);
  },
  array() {
    return array(this);
  },
  or(arg) {
    return union([this, arg]);
  },
  and(arg) {
    return intersection(this, arg);
  },
  transform(tx) {
    return pipe(this, transform(tx));
  },
  default(d) {
    return _default(this, d);
  },
  prefault(d) {
    return prefault(this, d);
  },
  catch(params) {
    return _catch(this, params);
  },
  pipe(target) {
    return pipe(this, target);
  },
  readonly() {
    return readonly(this);
  },
  describe(description) {
    const cl = this.clone();
    globalRegistry.add(cl, { description });
    return cl;
  },
  meta(...args) {
    if (args.length === 0)
      return globalRegistry.get(this);
    const cl = this.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  },
  isOptional() {
    return this.safeParse(undefined).success;
  },
  isNullable() {
    return this.safeParse(null).success;
  },
  apply(fn, ...args) {
    return args.length === 0 ? fn(this) : fn(this, ...args);
  },
  get "~standard"() {
    return hide(this, "~standard", {
      ...standardProps(this),
      jsonSchema: {
        input: createStandardJSONSchemaMethod(this, "input"),
        output: createStandardJSONSchemaMethod(this, "output")
      }
    });
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  },
  parse: function _parse(data, params) {
    return parse2(this, data, params, { callee: _parse });
  },
  parseAsync: async function _parseAsync(data, params) {
    return await parseAsync(this, data, params, { callee: _parseAsync });
  },
  safeParse(data, params) {
    return safeParse(this, data, params);
  },
  async safeParseAsync(data, params) {
    return safeParseAsync(this, data, params);
  },
  get spa() {
    return this?.safeParseAsync;
  },
  set spa(value) {
    own(this, "spa", value);
  },
  validate(data, params) {
    return validate(this, data, params);
  },
  validateAsync(data, params) {
    return validateAsync(this, data, params);
  },
  encode: function _encode(data, params) {
    return encode(this, data, params, { callee: _encode });
  },
  decode: function _decode(data, params) {
    return decode(this, data, params, { callee: _decode });
  },
  encodeAsync: async function _encodeAsync(data, params) {
    return await encodeAsync(this, data, params, { callee: _encodeAsync });
  },
  decodeAsync: async function _decodeAsync(data, params) {
    return await decodeAsync(this, data, params, { callee: _decodeAsync });
  },
  safeEncode(data, params) {
    return safeEncode(this, data, params);
  },
  safeDecode(data, params) {
    return safeDecode(this, data, params);
  },
  async safeEncodeAsync(data, params) {
    return safeEncodeAsync(this, data, params);
  },
  async safeDecodeAsync(data, params) {
    return safeDecodeAsync(this, data, params);
  },
  toJSONSchema(params) {
    return createToJSONSchemaMethod(this, {})(params);
  },
  get description() {
    return globalRegistry.get(this)?.description;
  },
  get _def() {
    return this._zod.def;
  }
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /* @__PURE__ */ derived({
  format: (inst) => aggregateChecks(inst).format ?? null,
  minLength: (inst) => aggregateChecks(inst).minimum ?? null,
  maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
  regex(...args) {
    return this.check(_regex(...args));
  },
  includes(...args) {
    return this.check(_includes(...args));
  },
  startsWith(...args) {
    return this.check(_startsWith(...args));
  },
  endsWith(...args) {
    return this.check(_endsWith(...args));
  },
  min(...args) {
    return this.check(_minLength(...args));
  },
  max(...args) {
    return this.check(_maxLength(...args));
  },
  length(...args) {
    return this.check(_length(...args));
  },
  nonempty(...args) {
    return this.check(_minLength(1, ...args));
  },
  lowercase(params) {
    return this.check(_lowercase(params));
  },
  uppercase(params) {
    return this.check(_uppercase(params));
  },
  trim() {
    return this.check(_trim());
  },
  normalize(...args) {
    return this.check(_normalize(...args));
  },
  toLowerCase() {
    return this.check(_toLowerCase());
  },
  toUpperCase() {
    return this.check(_toUpperCase());
  },
  slugify() {
    return this.check(_slugify());
  }
}));
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
}, {
  email(params) {
    return this.check(_email(ZodEmail, params));
  },
  url(params) {
    return this.check(_url(ZodURL, params));
  },
  jwt(params) {
    return this.check(_jwt(ZodJWT, params));
  },
  emoji(params) {
    return this.check(_emoji2(ZodEmoji, params));
  },
  guid(params) {
    return this.check(_guid(ZodGUID, params));
  },
  uuid(params) {
    return this.check(_uuid(ZodUUID, params));
  },
  uuidv4(params) {
    return this.check(_uuidv4(ZodUUID, params));
  },
  uuidv6(params) {
    return this.check(_uuidv6(ZodUUID, params));
  },
  uuidv7(params) {
    return this.check(_uuidv7(ZodUUID, params));
  },
  nanoid(params) {
    return this.check(_nanoid(ZodNanoID, params));
  },
  cuid(params) {
    return this.check(_cuid(ZodCUID, params));
  },
  cuid2(params) {
    return this.check(_cuid2(ZodCUID2, params));
  },
  ulid(params) {
    return this.check(_ulid(ZodULID, params));
  },
  base64(params) {
    return this.check(_base64(ZodBase64, params));
  },
  base64url(params) {
    return this.check(_base64url(ZodBase64URL, params));
  },
  xid(params) {
    return this.check(_xid(ZodXID, params));
  },
  ksuid(params) {
    return this.check(_ksuid(ZodKSUID, params));
  },
  ipv4(params) {
    return this.check(_ipv4(ZodIPv4, params));
  },
  ipv6(params) {
    return this.check(_ipv6(ZodIPv6, params));
  },
  cidrv4(params) {
    return this.check(_cidrv4(ZodCIDRv4, params));
  },
  cidrv6(params) {
    return this.check(_cidrv6(ZodCIDRv6, params));
  },
  e164(params) {
    return this.check(_e164(ZodE164, params));
  },
  datetime(params) {
    return this.check(_isoDateTime(ZodISODateTime, params));
  },
  date(params) {
    return this.check(_isoDate(ZodISODate, params));
  },
  time(params) {
    return this.check(_isoTime(ZodISOTime, params));
  },
  duration(params) {
    return this.check(_isoDuration(ZodISODuration, params));
  }
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  inst.isFinite = true;
}, /* @__PURE__ */ derived({
  minValue: (inst) => {
    const { minimum, exclusiveMinimum } = aggregateChecks(inst);
    return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
  },
  maxValue: (inst) => {
    const { maximum, exclusiveMaximum } = aggregateChecks(inst);
    return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
  },
  isInt: (inst) => {
    const { isInt, multipleOf } = aggregateChecks(inst);
    return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
  },
  format: (inst) => aggregateChecks(inst).format ?? null
}, {
  gt(value, params) {
    return this.check(_gt(value, params));
  },
  gte(value, params) {
    return this.check(_gte(value, params));
  },
  min(value, params) {
    return this.check(_gte(value, params));
  },
  lt(value, params) {
    return this.check(_lt(value, params));
  },
  lte(value, params) {
    return this.check(_lte(value, params));
  },
  max(value, params) {
    return this.check(_lte(value, params));
  },
  int(params) {
    return this.check(int(params));
  },
  safe(params) {
    return this.check(int(params));
  },
  positive(params) {
    return this.check(_gt(0, params));
  },
  nonnegative(params) {
    return this.check(_gte(0, params));
  },
  negative(params) {
    return this.check(_lt(0, params));
  },
  nonpositive(params) {
    return this.check(_lte(0, params));
  },
  multipleOf(value, params) {
    return this.check(_multipleOf(value, params));
  },
  step(value, params) {
    return this.check(_multipleOf(value, params));
  },
  finite() {
    return this;
  }
}));
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodBigInt = /* @__PURE__ */ $constructor("ZodBigInt", (inst, def) => {
  $ZodBigInt.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => bigintProcessor(inst, ctx, json, params);
}, /* @__PURE__ */ derived({
  minValue: (inst) => aggregateChecks(inst).minimum ?? null,
  maxValue: (inst) => aggregateChecks(inst).maximum ?? null,
  format: (inst) => aggregateChecks(inst).format ?? null
}, {
  gte(value, params) {
    return this.check(_gte(value, params));
  },
  min(value, params) {
    return this.check(_gte(value, params));
  },
  gt(value, params) {
    return this.check(_gt(value, params));
  },
  lt(value, params) {
    return this.check(_lt(value, params));
  },
  lte(value, params) {
    return this.check(_lte(value, params));
  },
  max(value, params) {
    return this.check(_lte(value, params));
  },
  positive(params) {
    return this.check(_gt(BigInt(0), params));
  },
  negative(params) {
    return this.check(_lt(BigInt(0), params));
  },
  nonpositive(params) {
    return this.check(_lte(BigInt(0), params));
  },
  nonnegative(params) {
    return this.check(_gte(BigInt(0), params));
  },
  multipleOf(value, params) {
    return this.check(_multipleOf(value, params));
  }
}));
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodDate = /* @__PURE__ */ $constructor("ZodDate", (inst, def) => {
  $ZodDate.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => dateProcessor(inst, ctx, json, params);
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
}, /* @__PURE__ */ derived({
  minDate: (inst) => {
    const { minimum } = aggregateChecks(inst);
    return minimum ? new Date(minimum) : null;
  },
  maxDate: (inst) => {
    const { maximum } = aggregateChecks(inst);
    return maximum ? new Date(maximum) : null;
  }
}, {}));
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
}, {
  min(n, params) {
    return this.check(_minLength(n, params));
  },
  nonempty(params) {
    return this.check(_minLength(1, params));
  },
  max(n, params) {
    return this.check(_maxLength(n, params));
  },
  length(n, params) {
    return this.check(_length(n, params));
  },
  unwrap() {
    return this.element;
  }
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
  keyof() {
    return _enum(Object.keys(this._zod.def.shape));
  },
  catchall(catchall) {
    return this.clone(mergeDefs(this._zod.def, { catchall }));
  },
  passthrough() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  loose() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  strict() {
    return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
  },
  strip() {
    return this.clone(mergeDefs(this._zod.def, { catchall: undefined }));
  },
  extend(incoming) {
    return extend(this, incoming);
  },
  safeExtend(incoming) {
    return safeExtend(this, incoming);
  },
  merge(other) {
    return merge(this, other);
  },
  pick(mask) {
    return pick(this, mask);
  },
  omit(mask) {
    return omit(this, mask);
  },
  partial(...args) {
    return partial(ZodOptional, this, args[0]);
  },
  exactPartial(...args) {
    return partial(ZodExactOptional, this, args[0], "exactPartial");
  },
  required(...args) {
    return required(ZodNonOptional, this, args[0]);
  }
});
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params)
  };
  return new ZodObject(def);
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodRecord({
      type: "record",
      keyType: string2(),
      valueType: keyType,
      ...normalizeParams(valueType)
    });
  }
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function partialRecord(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params),
    partial: true
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = [...inst._zod.values];
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
// node_modules/.bun/zod@4.6.5/node_modules/zod/v4/classic/coerce.js
var exports_coerce = {};
__export(exports_coerce, {
  bigint: () => bigint2,
  boolean: () => boolean3,
  date: () => date2,
  number: () => number3,
  string: () => string3
});
function string3(params) {
  return _coercedString(ZodString, params);
}
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
function boolean3(params) {
  return _coercedBoolean(ZodBoolean, params);
}
function bigint2(params) {
  return _coercedBigint(ZodBigInt, params);
}
function date2(params) {
  return _coercedDate(ZodDate, params);
}
// packages/core/src/schemas.ts
var slug = string2().regex(SLUG_RE).max(64);
var isoTs = string2();
var Layout = object({
  skills_dir: string2().default("skills"),
  nudges_dir: string2().default("nudges"),
  agents_dir: string2().default("agents"),
  rules_file: string2().default("RULES.md"),
  ledger: string2().default("promotions.json")
});
var V1_LAYOUT = {
  skills_dir: "claude/skills",
  nudges_dir: "claude/hooks/nudges",
  agents_dir: "claude/agents",
  rules_file: "global.CLAUDE.md",
  ledger: "claude/skills/promotions.json"
};
var OutlineExport = object({
  base_url: string2(),
  api_key_env: string2().default("OUTLINE_API_KEY"),
  collection_id: string2(),
  parent_document_id: string2().nullable().default(null)
});
var World = object({
  name: string2().regex(WORLD_NAME_RE),
  llm: _enum(["local", "cloud"]).default("cloud"),
  repos: array(string2()).default([]),
  target: string2().nullable().default(null),
  layout: Layout.default(() => Layout.parse({})),
  remote: _enum(["none", "push", "pr"]).default("none"),
  rules_inject: boolean2().default(true),
  outline: OutlineExport.nullable().default(null),
  llm_config: string2().nullable().default(null)
});
var Promotion = object({
  threshold: number2().int().min(1).default(3),
  per_run_cap: number2().int().min(1).default(3),
  auto_merge: boolean2().default(false),
  retire_after_days: number2().int().min(1).default(45)
});
var WorkerConfig = object({
  idle_minutes: number2().int().min(0).default(10),
  curriculum_interval_minutes: number2().int().min(1).default(60),
  min_tool_uses: number2().int().min(0).default(6),
  auto_kick: boolean2().default(true)
});
var WebConfig = object({
  port: number2().int().default(8766),
  host: string2().default("127.0.0.1"),
  allowed_hosts: array(string2()).default([])
});
var Config = object({
  version: number2().int().default(1),
  worlds: array(World).default(() => [World.parse({ name: "default" })]),
  promotion: Promotion.default(() => Promotion.parse({})),
  worker: WorkerConfig.default(() => WorkerConfig.parse({})),
  web: WebConfig.default(() => WebConfig.parse({}))
});
var Endpoint = object({
  name: string2().min(1),
  kind: _enum(["openai", "claude-cli"]).default("openai"),
  base_url: string2().nullable().default(null),
  api_key_env: string2().nullable().default(null),
  timeout_s: number2().int().min(1).default(240),
  models: partialRecord(_enum(ROLES), string2()).default({}),
  extra_body: record(string2(), unknown()).default({})
});
var LlmConfig = object({
  endpoints: array(Endpoint).default([]),
  active: string2().nullable().default(null),
  role_endpoints: partialRecord(_enum(ROLES), string2()).default({}),
  local_models: array(string2()).default([]),
  models: partialRecord(_enum(ROLES), string2()).default({})
});
var QueueEntry = object({
  session_id: string2().min(1),
  transcript_path: string2(),
  cwd: string2(),
  world: string2(),
  git_head: string2().nullable().default(null),
  first_stop: isoTs,
  last_stop: isoTs,
  stops: number2().int().default(1),
  ended: boolean2().default(false),
  tool_uses: number2().int().default(0),
  attempts: number2().int().default(0),
  result: string2().nullable().default(null)
});
var UsageEvent = object({
  ts: isoTs,
  session_id: string2(),
  world: string2(),
  kind: string2(),
  ref: string2(),
  detail: record(string2(), unknown()).default({})
});
var ARTIFACT_REF_RE = /^(skill|hook|rule|agent):[a-z0-9]+(?:-[a-z0-9]+)*$/;
var HumanFeedback = object({
  ts: isoTs,
  world: string2(),
  ref: string2().regex(ARTIFACT_REF_RE),
  vote: _enum(["good", "bad"]),
  note: string2().default(""),
  session_id: string2().nullable().default(null)
});
var Proposal = _enum(["keep", "refine", "retire-candidate", "new"]);
var Scorecard = object({
  ref: string2(),
  type: string2(),
  name: string2(),
  uses_30d: number2().int().default(0),
  fires_30d: number2().int().default(0),
  helpful: number2().int().default(0),
  misfired: number2().int().default(0),
  human_good: number2().int().default(0),
  human_bad: number2().int().default(0),
  last_used: isoTs.nullable().default(null),
  proposal: Proposal.default("keep"),
  reason: string2().default("")
});
var Reflection = object({
  id: string2(),
  world: string2(),
  pattern: slug,
  path: string2(),
  created: string2(),
  session_id: string2().nullable().default(null),
  cwd: string2().nullable().default(null),
  revision: string2().nullable().default(null),
  model: string2().nullable().default(null),
  artifacts_used: array(string2()).default([]),
  artifacts_helpful: array(string2()).default([]),
  artifacts_misfired: array(string2()).default([]),
  lesson: string2().default(""),
  body: string2().default("")
});
var Lesson = object({
  id: string2(),
  world: string2(),
  pattern: slug,
  text: string2().min(1),
  created: isoTs,
  reflection_id: string2().nullable().default(null),
  repo: string2().nullable().default(null),
  deliveries: number2().int().default(0)
});
var ArtifactType = _enum(["skill", "hook", "rule", "agent", "none"]);
var ArtifactRef = object({ type: ArtifactType, path: string2().nullable().default(null) });
var PromotionStatus = _enum(["staged", "promoted", "rejected", "retired"]);
var PromotionEntry = object({
  pattern: slug,
  promoted_at_count: number2().int().default(0),
  rejected_at_count: number2().int().default(0),
  status: PromotionStatus.default("staged"),
  artifact_type: ArtifactType.default("none"),
  served_by: ArtifactRef.nullable().default(null),
  last_updated: isoTs.default(() => new Date().toISOString()),
  promoted_at: isoTs.nullable().default(null),
  commit: string2().nullable().default(null),
  feedback: Scorecard.nullable().default(null)
});
var Ledger = object({
  version: number2().int().default(1),
  entries: record(string2(), PromotionEntry).default({})
});
var PlanActionKind = _enum(["promote", "refine", "over-cap", "below-threshold", "done", "retire-candidate"]);
var PlanAction = object({
  pattern: slug,
  count: number2().int(),
  watermark: number2().int(),
  action: PlanActionKind,
  sources: array(string2()).default([]),
  reason: string2().default("")
});
var PlanReport = object({ world: string2(), threshold: number2().int(), actions: array(PlanAction).default([]) });
var RunReport = object({
  world: string2(),
  dry_run: boolean2().default(true),
  staged: array(string2()).default([]),
  merged: array(string2()).default([]),
  gated_out: record(string2(), string2()).default({}),
  dropped: record(string2(), number2().int()).default({}),
  started: isoTs,
  finished: isoTs.nullable().default(null),
  error: string2().nullable().default(null)
});
var ReviewItem = object({
  world: string2(),
  pattern: slug,
  branch: string2(),
  artifact_type: ArtifactType,
  artifact_path: string2().nullable().default(null),
  count: number2().int().default(0),
  staged_at: string2().nullable().default(null),
  commit: string2().nullable().default(null)
});
var ReviewDetail = ReviewItem.extend({
  body: string2().default(""),
  sources: array(string2()).default([]),
  reviewed_state: string2().regex(/^[0-9a-f]{64}$/),
  accept_blocked: string2().nullable().default(null)
});
var ReviewDiff = object({
  world: string2(),
  pattern: slug,
  diff: string2(),
  reviewed_state: string2().regex(/^[0-9a-f]{64}$/)
});
var RouterRow = object({
  pattern: slug,
  artifact_type: ArtifactType,
  served_by: string2().nullable().default(null),
  status: string2(),
  reflections: number2().int().default(0),
  scorecard: Scorecard.nullable().default(null)
});
var HookWorld = object({
  name: string2(),
  repos: array(string2()),
  nudges_dir: string2(),
  rules_file: string2(),
  rules_inject: boolean2()
});
var HookSnapshot = object({
  version: number2().int(),
  worlds: array(HookWorld),
  worker: WorkerConfig,
  plugin_root: string2()
});
// packages/core/src/paths.ts
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
function envPath(name, fallback) {
  const raw = process.env[name];
  return raw && raw.length > 0 ? expandHome(raw) : fallback;
}
function expandHome(p) {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
function configDir() {
  return envPath("SIL_CONFIG_DIR", join(envPath("XDG_CONFIG_HOME", join(homedir(), ".config")), "self-improvement-loop"));
}
function stateDir() {
  return envPath("SIL_STATE_DIR", join(envPath("XDG_STATE_HOME", join(homedir(), ".local", "state")), "self-improvement-loop"));
}
function dataDir() {
  return envPath("SIL_DATA_DIR", join(envPath("XDG_DATA_HOME", join(homedir(), ".local", "share")), "self-improvement-loop"));
}
var manifestRoot;
function findManifestRoot(start) {
  let dir = resolve(start);
  for (;; ) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function pluginRoot() {
  const raw = process.env["CLAUDE_PLUGIN_ROOT"];
  if (raw)
    return raw;
  if (manifestRoot === undefined)
    manifestRoot = findManifestRoot(import.meta.dir);
  return manifestRoot ?? resolve(import.meta.dir, "..", "..", "..");
}
function claudeConfigDir() {
  return envPath("CLAUDE_CONFIG_DIR", join(homedir(), ".claude"));
}
var configFile = () => join(configDir(), "config.yaml");
var llmFile = () => join(configDir(), "llm.yaml");
var queueDir = (bucket) => join(stateDir(), "queue", bucket);
var usageEventsFile = () => join(stateDir(), "usage", "events.jsonl");
var nudgeFiresFile = () => join(stateDir(), "usage", "nudge-fires.jsonl");
var humanFeedbackFile = () => join(stateDir(), "feedback", "human.jsonl");
var criticFeedbackFile = () => join(stateDir(), "feedback", "critic.jsonl");
var inboxDir = (world) => join(stateDir(), "inbox", safeComponent(world));
var sessionDir = (sessionId) => join(stateDir(), "sessions", safeComponent(sessionId));
var workerLockFile = () => join(stateDir(), "worker.lock");
var hookSnapshotFile = () => join(stateDir(), "hook-config.json");
var webTokenFile = () => join(stateDir(), "web-token");
var logFile = (name) => join(stateDir(), "logs", `${safeComponent(name)}.log`);
var worldDir = (world) => join(dataDir(), "worlds", safeComponent(world));
var reflectionsDir = (world) => join(worldDir(world), "reflections");
var aliasesFile = (world) => join(worldDir(world), "aliases.json");
var scorecardsFile = (world) => join(worldDir(world), "scorecards.json");
var defaultTarget = (world) => join(worldDir(world), "learned");
var SAFE_CHAR = /[\p{L}\p{N}._-]/u;
function safeComponent(name) {
  const cleaned = Array.from(name.normalize("NFC"), (c) => SAFE_CHAR.test(c) ? c : "_").join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}
// packages/core/src/fsx.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname as dirname2, join as join2 } from "path";
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}
function exists(path) {
  return existsSync2(path);
}
function readText(path) {
  return readFileSync(path, "utf8");
}
function readTextOr(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}
function atomicWrite(path, text) {
  ensureDir(dirname2(path));
  const tmp = join2(dirname2(path), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
function writeJson(path, value) {
  atomicWrite(path, JSON.stringify(value, null, 2) + `
`);
}
function readJsonOr(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(`
`)) {
    const t = line.trim();
    if (!t)
      continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object")
        out.push(v);
    } catch {}
  }
  return out;
}
function appendJsonl(path, record) {
  ensureDir(dirname2(path));
  appendFileSync(path, JSON.stringify(record) + `
`, "utf8");
}
var ROTATE_AT_BYTES = 10 * 1024 * 1024;
var ROTATE_KEEP_LINES = 5000;
function appendLine(path, line, rotateAt = ROTATE_AT_BYTES, keep = ROTATE_KEEP_LINES) {
  ensureDir(dirname2(path));
  try {
    if (statSync(path).size >= rotateAt) {
      const lines = readFileSync(path, "utf8").split(`
`).filter((l) => l.length > 0);
      atomicWrite(path, lines.slice(-keep).join(`
`) + `
`);
    }
  } catch {}
  appendFileSync(path, line.endsWith(`
`) ? line : line + `
`, "utf8");
}
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
function nowIso() {
  return new Date().toISOString();
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
// packages/core/src/config.ts
import { realpathSync } from "fs";
import { isAbsolute, join as join3, relative, resolve as resolve2 } from "path";

// node_modules/.bun/yaml@2.9.1/node_modules/yaml/dist/index.js
var exports_dist = {};
__exportCjs(exports_dist, {
  Composer: () => $Composer,
  Document: () => $Document,
  Schema: () => $Schema,
  YAMLError: () => $YAMLError,
  YAMLParseError: () => $YAMLParseError,
  YAMLWarning: () => $YAMLWarning,
  Alias: () => $Alias,
  isAlias: () => $isAlias,
  isCollection: () => $isCollection,
  isDocument: () => $isDocument,
  isMap: () => $isMap,
  isNode: () => $isNode,
  isPair: () => $isPair,
  isScalar: () => $isScalar,
  isSeq: () => $isSeq,
  Pair: () => $Pair,
  Scalar: () => $Scalar,
  YAMLMap: () => $YAMLMap,
  YAMLSeq: () => $YAMLSeq,
  CST: () => $CST,
  Lexer: () => $Lexer,
  LineCounter: () => $LineCounter,
  Parser: () => $Parser,
  parse: () => $parse,
  parseAllDocuments: () => $parseAllDocuments,
  parseDocument: () => $parseDocument,
  stringify: () => $stringify,
  visit: () => $visit,
  visitAsync: () => $visitAsync
}, {
  Composer: (value) => $Composer = value,
  Document: (value) => $Document = value,
  Schema: (value) => $Schema = value,
  YAMLError: (value) => $YAMLError = value,
  YAMLParseError: (value) => $YAMLParseError = value,
  YAMLWarning: (value) => $YAMLWarning = value,
  Alias: (value) => $Alias = value,
  isAlias: (value) => $isAlias = value,
  isCollection: (value) => $isCollection = value,
  isDocument: (value) => $isDocument = value,
  isMap: (value) => $isMap = value,
  isNode: (value) => $isNode = value,
  isPair: (value) => $isPair = value,
  isScalar: (value) => $isScalar = value,
  isSeq: (value) => $isSeq = value,
  Pair: (value) => $Pair = value,
  Scalar: (value) => $Scalar = value,
  YAMLMap: (value) => $YAMLMap = value,
  YAMLSeq: (value) => $YAMLSeq = value,
  CST: (value) => $CST = value,
  Lexer: (value) => $Lexer = value,
  LineCounter: (value) => $LineCounter = value,
  Parser: (value) => $Parser = value,
  parse: (value) => $parse = value,
  parseAllDocuments: (value) => $parseAllDocuments = value,
  parseDocument: (value) => $parseDocument = value,
  stringify: (value) => $stringify = value,
  visit: (value) => $visit = value,
  visitAsync: (value) => $visitAsync = value
});
var composer = require_composer();
var Document = require_Document();
var Schema = require_Schema();
var errors3 = require_errors();
var Alias = require_Alias();
var identity = require_identity();
var Pair = require_Pair();
var Scalar = require_Scalar();
var YAMLMap = require_YAMLMap();
var YAMLSeq = require_YAMLSeq();
var cst = require_cst();
var lexer = require_lexer();
var lineCounter = require_line_counter();
var parser = require_parser();
var publicApi = require_public_api();
var visit = require_visit();
var $Composer = composer.Composer;
var $Document = Document.Document;
var $Schema = Schema.Schema;
var $YAMLError = errors3.YAMLError;
var $YAMLParseError = errors3.YAMLParseError;
var $YAMLWarning = errors3.YAMLWarning;
var $Alias = Alias.Alias;
var $isAlias = identity.isAlias;
var $isCollection = identity.isCollection;
var $isDocument = identity.isDocument;
var $isMap = identity.isMap;
var $isNode = identity.isNode;
var $isPair = identity.isPair;
var $isScalar = identity.isScalar;
var $isSeq = identity.isSeq;
var $Pair = Pair.Pair;
var $Scalar = Scalar.Scalar;
var $YAMLMap = YAMLMap.YAMLMap;
var $YAMLSeq = YAMLSeq.YAMLSeq;
var $CST = cst;
var $Lexer = lexer.Lexer;
var $LineCounter = lineCounter.LineCounter;
var $Parser = parser.Parser;
var $parse = publicApi.parse;
var $parseAllDocuments = publicApi.parseAllDocuments;
var $parseDocument = publicApi.parseDocument;
var $stringify = publicApi.stringify;
var $visit = visit.visit;
var $visitAsync = visit.visitAsync;

// packages/core/src/config.ts
function parseYamlFile(path) {
  try {
    return exports_dist.parse(readText(path)) ?? {};
  } catch (e) {
    throw new ConfigError(`invalid ${path}: ${e.message.split(`
`)[0]}`);
  }
}
function loadConfig(path = configFile()) {
  if (!exists(path))
    return Config.parse({});
  const raw = parseYamlFile(path);
  const parsed = Config.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(`invalid ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
function saveConfig(cfg, path = configFile()) {
  atomicWrite(path, exports_dist.stringify(Config.parse(cfg)));
  return path;
}
function worldNamed(cfg, name) {
  const w = cfg.worlds.find((x) => x.name === name);
  if (!w)
    throw new ConfigError(`unknown world: ${JSON.stringify(name)}`);
  return w;
}
function realOrResolve(p) {
  const abs = resolve2(expandHome(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function worldForCwd(cfg, cwd) {
  const target = realOrResolve(cwd);
  let best = null;
  let fallback = null;
  for (const w of cfg.worlds) {
    if (w.repos.length === 0 && fallback === null)
      fallback = w;
    for (const repo of w.repos) {
      const r = realOrResolve(repo);
      if (isWithin(target, r)) {
        const score = r.split("/").length;
        if (!best || score > best.score)
          best = { score, world: w };
      }
    }
  }
  if (best)
    return best.world;
  if (fallback)
    return fallback;
  throw new ConfigError(`no world owns ${target} and no catch-all world exists`);
}
function targetRoot(world) {
  return expandHome(world.target ?? defaultTarget(world.name));
}
function ledgerPath(world) {
  return join3(targetRoot(world), world.layout.ledger);
}
function loadLlm(world, path) {
  const p = expandHome(path ?? world?.llm_config ?? llmFile());
  if (!exists(p))
    return LlmConfig.parse({});
  const raw = parseYamlFile(p);
  const parsed = LlmConfig.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(`invalid ${p}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
function saveLlm(llm, path = llmFile()) {
  atomicWrite(path, exports_dist.stringify(LlmConfig.parse(llm)));
  return path;
}
function activeEndpoint(llm) {
  if (llm.endpoints.length === 0)
    throw new ModelNotConfigured("llm.yaml has no endpoints; run `sil init` or edit it");
  const name = llm.active ?? llm.endpoints[0].name;
  const e = llm.endpoints.find((x) => x.name === name);
  if (!e)
    throw new ModelNotConfigured(`llm.yaml active endpoint ${JSON.stringify(name)} is not defined`);
  return e;
}
function requireRole(role) {
  if (!ROLES.includes(role))
    throw new ConfigError(`unknown model role ${role}; roles are ${ROLES.join(", ")}`);
}
function endpointFor(llm, role) {
  requireRole(role);
  if (llm.endpoints.length === 0)
    throw new ModelNotConfigured("llm.yaml has no endpoints; run `sil init` or edit it");
  const override = llm.role_endpoints[role];
  const name = override ?? llm.active ?? llm.endpoints[0].name;
  const e = llm.endpoints.find((x) => x.name === name);
  if (!e) {
    const where = override ? `role_endpoints.${role}` : "active";
    throw new ModelNotConfigured(`llm.yaml ${where} endpoint ${JSON.stringify(name)} is not defined`);
  }
  return e;
}
function resolveRole(llm, role, world) {
  requireRole(role);
  const endpoint = endpointFor(llm, role);
  const model = endpoint.models[role] ?? llm.models[role];
  if (!model) {
    throw new ModelNotConfigured(`no model for role ${role} on endpoint ${endpoint.name}; ` + `set endpoints[${endpoint.name}].models.${role} in llm.yaml or run sil llm set-model`);
  }
  if (world && world.llm === "local" && !llm.local_models.includes(model)) {
    throw new LocalityViolation(`world ${world.name} is llm: local but models.${role}=${model} is not in local_models`);
  }
  return { endpoint, model };
}
function modelFor(llm, role, world) {
  return resolveRole(llm, role, world).model;
}
function useEndpoint(llm, name, role) {
  if (!llm.endpoints.some((e) => e.name === name)) {
    const known = llm.endpoints.map((e) => e.name).join(", ") || "none";
    throw new ConfigError(`unknown endpoint ${JSON.stringify(name)}; llm.yaml defines ${known}`);
  }
  if (role === undefined)
    return { ...llm, active: name, role_endpoints: {} };
  requireRole(role);
  return { ...llm, role_endpoints: { ...llm.role_endpoints, [role]: name } };
}
function apiKey(endpoint) {
  if (endpoint.kind === "claude-cli")
    return null;
  if (!endpoint.api_key_env)
    return null;
  const value = process.env[endpoint.api_key_env];
  if (!value)
    throw new ModelNotConfigured(`env var ${endpoint.api_key_env} (api_key_env) is not set`);
  return value;
}
function writeHookSnapshot(cfg = loadConfig()) {
  const snap = {
    version: 1,
    worlds: cfg.worlds.map((w) => {
      const root = targetRoot(w);
      return {
        name: w.name,
        repos: w.repos.map((r) => realOrResolve(r)),
        nudges_dir: join3(root, w.layout.nudges_dir),
        rules_file: join3(root, w.layout.rules_file),
        rules_inject: w.rules_inject
      };
    }),
    worker: cfg.worker,
    plugin_root: pluginRoot()
  };
  const p = hookSnapshotFile();
  writeJson(p, snap);
  return p;
}
// apps/cli/src/common.ts
function resolveWorld(cfg, name) {
  if (name)
    return worldNamed(cfg, name);
  return worldForCwd(cfg, process.cwd());
}
function zodField(path) {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number")
      out += `[${seg}]`;
    else
      out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out || "(root)";
}
function zodDetail(err) {
  return err.issues.map((i) => `${zodField(i.path)}: ${i.message}`).join("; ");
}
function mapKnownError(err) {
  if (err instanceof ZodError) {
    console.error(`config error: ${zodDetail(err)}`);
    return 1;
  }
  if (err instanceof LockHeld) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  if (err instanceof ConfigError) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  if (err instanceof ReviewError || err instanceof GitError || err instanceof ProviderError || err instanceof ValidationError) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  return null;
}

// packages/curriculum/src/index.ts
var exports_src4 = {};
__export(exports_src4, {
  GATE_TIMEOUT_MS: () => GATE_TIMEOUT_MS,
  HOOK_KEYS: () => HOOK_KEYS,
  MAX_DESCRIPTION: () => MAX_DESCRIPTION,
  MAX_RULE_CHARS: () => MAX_RULE_CHARS,
  MIN_BODY_CHARS: () => MIN_BODY_CHARS,
  MIN_QUOTE_CHARS: () => MIN_QUOTE_CHARS,
  MIN_QUOTE_TERMS: () => MIN_QUOTE_TERMS,
  MIN_QUOTE_WORDS: () => MIN_QUOTE_WORDS,
  MIN_SHARED_TERMS: () => MIN_SHARED_TERMS,
  RouteAnswer: () => RouteAnswer,
  SECRET_RE: () => SECRET_RE,
  allowedPaths: () => allowedPaths,
  artifactPrefixes: () => artifactPrefixes,
  artifactRel: () => artifactRel,
  artifacts: () => exports_artifacts,
  branchName: () => branchName,
  cluster: () => cluster,
  distinctiveTerms: () => distinctiveTerms,
  draftMessages: () => draftMessages,
  emptyAnswer: () => emptyAnswer,
  ensureRulesFile: () => ensureRulesFile,
  foreignRuleTags: () => foreignRuleTags,
  git: () => exports_git,
  isPlaceholderBody: () => isPlaceholderBody,
  judgeMessages: () => judgeMessages,
  lessonTexts: () => lessonTexts,
  lint: () => lint,
  lintDescriptionCap: () => lintDescriptionCap,
  lintGrounding: () => lintGrounding,
  lintHook: () => lintHook,
  lintRule: () => lintRule,
  lintSkill: () => lintSkill,
  loadLedger: () => loadLedger2,
  loadPayloadCorpus: () => loadPayloadCorpus,
  parseDraft: () => parseDraft,
  parseVerdict: () => parseVerdict,
  placeholderBody: () => placeholderBody,
  plan: () => plan,
  prompts: () => exports_prompts,
  readArtifact: () => readArtifact,
  reflections: () => reflections2,
  removeArtifact: () => removeArtifact,
  route: () => route,
  ruleBulletInText: () => ruleBulletInText,
  rulesDiffOwnedBy: () => rulesDiffOwnedBy,
  rulesProblem: () => rulesProblem,
  run: () => run,
  scorecardByPattern: () => scorecardByPattern,
  scorecards: () => scorecards2,
  setNudgeAdapter: () => setNudgeAdapter,
  sourcesText: () => sourcesText,
  splitTrigger: () => splitTrigger2,
  stripRuleTag: () => stripRuleTag,
  substantiveQuote: () => substantiveQuote,
  watermark: () => watermark,
  writeArtifact: () => writeArtifact
});

// packages/curriculum/src/git.ts
var exports_git = {};
__export(exports_git, {
  DEFAULT_TIMEOUT_MS: () => DEFAULT_TIMEOUT_MS,
  commitPaths: () => commitPaths,
  currentBranch: () => currentBranch,
  defaultBranch: () => defaultBranch,
  dirtyPaths: () => dirtyPaths,
  ensureIdentity: () => ensureIdentity,
  ensureRepo: () => ensureRepo,
  git: () => git,
  gitRaw: () => gitRaw,
  hasGh: () => hasGh,
  head: () => head,
  isAncestor: () => isAncestor,
  isRepo: () => isRepo,
  isTimeoutSignal: () => isTimeoutSignal,
  refExists: () => refExists,
  show: () => show,
  signalMessage: () => signalMessage,
  withScratchWorktree: () => withScratchWorktree
});
import { mkdirSync as mkdirSync2, mkdtempSync, rmSync, statSync as statSync2 } from "fs";
import { tmpdir } from "os";
import { join as join4 } from "path";
var DEFAULT_TIMEOUT_MS = 60000;
function isTimeoutSignal(signal, elapsedMs, timeoutMs) {
  return signal === "SIGTERM" && elapsedMs >= timeoutMs;
}
function signalMessage(args, signal, elapsedMs, timeoutMs) {
  const what = `git ${args.join(" ")}`;
  if (isTimeoutSignal(signal, elapsedMs, timeoutMs))
    return `${what} timed out after ${timeoutMs}ms`;
  return `${what} was killed by ${signal ?? "an unknown signal"} after ${elapsedMs}ms`;
}
function gitRaw(repo, args, timeout = DEFAULT_TIMEOUT_MS) {
  let proc;
  const started = Date.now();
  try {
    proc = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout });
  } catch (e) {
    return { code: 127, stdout: "", stderr: e.message, signal: null, elapsedMs: 0, timedOut: false };
  }
  const elapsedMs = Date.now() - started;
  const signal = proc.exitCode === null ? proc.signalCode ?? null : null;
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    signal,
    elapsedMs,
    timedOut: isTimeoutSignal(signal, elapsedMs, timeout)
  };
}
function git(repo, args, opts = {}) {
  const check = opts.check ?? true;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const res = gitRaw(repo, args, timeout);
  if (res.signal !== null) {
    if (!check)
      return "";
    throw new GitError(signalMessage(args, res.signal, res.elapsedMs, timeout), res.stderr);
  }
  if (res.code !== 0) {
    if (!check)
      return "";
    const detail = (res.stderr || res.stdout).trim() || `exited ${res.code}`;
    throw new GitError(`git ${args.join(" ")}: ${detail}`, res.stderr);
  }
  return res.stdout.trim();
}
function isRepo(path) {
  try {
    if (!statSync2(path).isDirectory())
      return false;
  } catch {
    return false;
  }
  return git(path, ["rev-parse", "--git-dir"], { check: false }) !== "";
}
function head(repo) {
  return git(repo, ["rev-parse", "HEAD"], { check: false });
}
function currentBranch(repo) {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { check: false });
}
function refExists(repo, ref) {
  return git(repo, ["rev-parse", "--verify", "--quiet", ref], { check: false }) !== "";
}
function defaultBranch(repo) {
  for (const name of ["main", "master"]) {
    if (refExists(repo, `refs/heads/${name}`))
      return name;
  }
  return currentBranch(repo) || "main";
}
var LOOP_EMAIL = "loop@self-improvement-loop.local";
var LOOP_NAME = "self-improvement-loop";
function ensureIdentity(repo) {
  if (gitRaw(repo, ["var", "GIT_COMMITTER_IDENT"]).code === 0)
    return;
  git(repo, ["config", "user.email", LOOP_EMAIL]);
  git(repo, ["config", "user.name", LOOP_NAME]);
  git(repo, ["config", "commit.gpgsign", "false"]);
}
function ensureRepo(path) {
  mkdirSync2(path, { recursive: true });
  if (isRepo(path)) {
    ensureIdentity(path);
    return path;
  }
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", LOOP_EMAIL]);
  git(path, ["config", "user.name", LOOP_NAME]);
  git(path, ["config", "commit.gpgsign", "false"]);
  git(path, ["commit", "-q", "--allow-empty", "-m", "chore: initialise learned repo"]);
  return path;
}
function hooksOff(parent) {
  const empty = join4(parent, "nohooks");
  mkdirSync2(empty, { recursive: true });
  return ["-c", `core.hooksPath=${empty}`];
}
function withScratchWorktree(repo, branch, base, fn) {
  const tmp = mkdtempSync(join4(tmpdir(), "sil-wt-"));
  const workDir = join4(tmp, "wt");
  const created = !refExists(repo, `refs/heads/${branch}`);
  let threw = true;
  try {
    const hooks = hooksOff(tmp);
    if (created) {
      git(repo, [...hooks, "worktree", "add", "-q", "-b", branch, workDir, base]);
    } else {
      git(repo, [...hooks, "worktree", "add", "-q", workDir, branch]);
    }
    const out = fn(workDir);
    threw = false;
    return out;
  } finally {
    git(repo, ["worktree", "remove", "--force", workDir], { check: false });
    rmSync(tmp, { recursive: true, force: true });
    git(repo, ["worktree", "prune"], { check: false });
    if (created && threw)
      git(repo, ["branch", "-q", "-D", branch], { check: false });
  }
}
function dirtyPaths(repo, prefix, opts = {}) {
  const prefixes = (typeof prefix === "string" ? [prefix] : prefix).filter((p) => p.length > 0);
  if (prefixes.length === 0)
    return [];
  const mode = opts.includeUntracked ? "--untracked-files=all" : "--untracked-files=no";
  const out = git(repo, ["status", "--porcelain", "-z", mode, "--", ...prefixes], { check: false });
  return out.split("\x00").filter((rec) => rec.length > 3).map((rec) => rec.slice(3)).sort();
}
function commitPaths(repo, base, ref) {
  const out = git(repo, ["diff", "--name-only", `${base}...${ref}`], { check: false });
  return out.split(`
`).filter((line) => line.trim().length > 0).sort();
}
function show(repo, ref, rel) {
  const res = gitRaw(repo, ["show", `${ref}:${rel}`]);
  if (res.code !== 0)
    return { found: false, text: "" };
  return { found: true, text: res.stdout };
}
function isAncestor(repo, ancestor, descendant) {
  return gitRaw(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).code === 0;
}
function hasGh() {
  return Bun.which("gh") !== null;
}
// packages/curriculum/src/artifacts.ts
var exports_artifacts = {};
__export(exports_artifacts, {
  HOOK_KEYS: () => HOOK_KEYS,
  RULE_END: () => RULE_END,
  RULE_START: () => RULE_START,
  RULE_TAG_OPEN: () => RULE_TAG_OPEN,
  TYPES: () => TYPES,
  allowedPaths: () => allowedPaths,
  artifactPrefixes: () => artifactPrefixes,
  artifactRel: () => artifactRel,
  ensureRulesFile: () => ensureRulesFile,
  foreignRuleTags: () => foreignRuleTags,
  isPlaceholderBody: () => isPlaceholderBody,
  ownsRulesFile: () => ownsRulesFile,
  placeholderBody: () => placeholderBody,
  readArtifact: () => readArtifact,
  removeArtifact: () => removeArtifact,
  ruleBulletInText: () => ruleBulletInText,
  ruleTag: () => ruleTag,
  rulesDiffOwnedBy: () => rulesDiffOwnedBy,
  rulesProblem: () => rulesProblem,
  stripRuleTag: () => stripRuleTag,
  writeArtifact: () => writeArtifact
});
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync, rmdirSync, statSync as statSync3, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname3, join as join5, resolve as resolve3 } from "path";
var TYPES = ["skill", "hook", "rule", "agent"];
var HOOK_KEYS = ["pattern", "event", "matcher", "gate", "once_per", "text"];
var RULE_TAG_OPEN = ruleTag("").replace("-->", "");
var strip = (p) => p.replace(/^\/+/, "").replace(/\/+$/, "");
function artifactRel(world, artifactType, pattern) {
  if (!isSlug(pattern))
    throw new ValidationError(`unsafe pattern slug ${JSON.stringify(pattern)}`);
  const layout = world.layout;
  switch (artifactType) {
    case "skill":
      return `${strip(layout.skills_dir)}/${pattern}/SKILL.md`;
    case "hook":
      return `${strip(layout.nudges_dir)}/${pattern}.json`;
    case "agent":
      return `${strip(layout.agents_dir)}/${pattern}.md`;
    case "rule":
      return strip(layout.rules_file);
    case "none":
      return "";
    default:
      throw new ValidationError(`unknown artifact type ${JSON.stringify(artifactType)}`);
  }
}
function artifactPrefixes(world) {
  const layout = world.layout;
  return [...new Set([
    strip(layout.skills_dir),
    strip(layout.nudges_dir),
    strip(layout.agents_dir),
    strip(layout.rules_file),
    strip(layout.ledger)
  ])].sort();
}
function allowedPaths(world, pattern) {
  const out = new Set([strip(world.layout.ledger)]);
  for (const t of TYPES) {
    const rel = artifactRel(world, t, pattern);
    if (rel)
      out.add(rel);
  }
  return out;
}
function rootFor(world, root) {
  return root != null ? root : targetRoot(world);
}
function readArtifact(world, artifactType, pattern, root) {
  const rel = artifactRel(world, artifactType, pattern);
  if (!rel)
    return "";
  const path = join5(rootFor(world, root), rel);
  if (!existsSync3(path))
    return "";
  const text = readText(path);
  return artifactType === "rule" ? stripRuleTag(ruleBulletInText(text, pattern), pattern) : text;
}
function writeArtifact(world, artifactType, pattern, payload, root) {
  const rel = artifactRel(world, artifactType, pattern);
  if (!rel)
    return null;
  const path = join5(rootFor(world, root), rel);
  if (artifactType === "rule") {
    writeRule(path, pattern, String(payload).trim());
    return path;
  }
  mkdirSync3(dirname3(path), { recursive: true });
  if (artifactType === "hook") {
    writeFileSync2(path, JSON.stringify(hookPayload(payload), null, 2) + `
`, "utf8");
  } else {
    writeFileSync2(path, String(payload), "utf8");
  }
  return path;
}
function hookPayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const src = payload;
  const out = {};
  for (const key of HOOK_KEYS) {
    if (key in src)
      out[key] = src[key];
  }
  return out;
}
function removeArtifact(world, artifactType, pattern, root) {
  const rel = artifactRel(world, artifactType, pattern);
  if (!rel)
    return "";
  const path = join5(rootFor(world, root), rel);
  if (artifactType === "rule")
    return removeRuleBullet(path, pattern) ? rel : "";
  if (!existsSync3(path))
    return "";
  unlinkSync(path);
  const parent = dirname3(path);
  if (artifactType === "skill") {
    try {
      if (statSync3(parent).isDirectory() && readdirSync(parent).length === 0)
        rmdirSync(parent);
    } catch {}
  }
  return rel;
}
var RULE_TAG_RE = /<!--rule:([A-Za-z0-9][A-Za-z0-9-]*)-->/g;
function foreignRuleTags(diffText, pattern) {
  const tags = new Set;
  for (const line of diffText.split(`
`)) {
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      for (const m of line.matchAll(RULE_TAG_RE))
        tags.add(m[1]);
    }
  }
  tags.delete(pattern);
  return [...tags].sort();
}
function rulesDiffOwnedBy(diffText, pattern) {
  const tag = ruleTag(pattern);
  for (const line of diffText.split(`
`)) {
    if (!(line.startsWith("+") || line.startsWith("-")) || line.startsWith("+++") || line.startsWith("---"))
      continue;
    const body = line.slice(1).trim();
    if (body !== "" && !body.endsWith(tag))
      return false;
  }
  return true;
}
function stripRuleTag(bullet, pattern) {
  const tag = ruleTag(pattern);
  let out = (bullet ?? "").replace(/\s+$/, "");
  while (out.endsWith(tag))
    out = out.slice(0, -tag.length).replace(/\s+$/, "");
  return out;
}
function ruleBulletInText(text, pattern) {
  const tag = ruleTag(pattern);
  for (const line of text.split(`
`)) {
    if (line.replace(/\s+$/, "").endsWith(tag))
      return line;
  }
  return "";
}
function rulesProblem(world, root) {
  const path = join5(rootFor(world, root), strip(world.layout.rules_file));
  let text;
  try {
    text = existsSync3(path) ? readText(path) : "";
  } catch (e) {
    return `${path} is unreadable: ${e.message}`;
  }
  return markerProblem(path, text);
}
function count(text, needle) {
  return text.split(needle).length - 1;
}
function markerProblem(path, text) {
  const starts = count(text, RULE_START);
  const ends = count(text, RULE_END);
  if (starts === 0 || ends === 0) {
    return `${path} has no ${RULE_START} / ${RULE_END} marker pair; refusing to append blind to a hand-maintained file`;
  }
  if (starts > 1 || ends > 1) {
    return `${path} has ${starts} start and ${ends} end marker(s); ambiguous which pair is live, refusing to guess`;
  }
  if (text.indexOf(RULE_START) > text.indexOf(RULE_END)) {
    return `${path} has ${RULE_END} before ${RULE_START}; malformed marker order, refusing to guess the managed region`;
  }
  return null;
}
function ownsRulesFile(world) {
  return resolve3(targetRoot(world)) === resolve3(defaultTarget(world.name));
}
function ensureRulesFile(world, root) {
  if (!ownsRulesFile(world))
    return null;
  const path = join5(rootFor(world, root), strip(world.layout.rules_file));
  if (existsSync3(path))
    return path;
  mkdirSync3(dirname3(path), { recursive: true });
  writeFileSync2(path, `# Learned rules

Promoted by the loop. Edit outside the markers only.

${RULE_START}
${RULE_END}
`, "utf8");
  return path;
}
function writeRule(path, pattern, bullet) {
  for (const marker of [RULE_START, RULE_END, RULE_TAG_OPEN]) {
    if (bullet.includes(marker)) {
      throw new ValidationError(`refusing to write a rule bullet containing ${JSON.stringify(marker)}: it would wedge ${path} for every later write and for retire`);
    }
  }
  const text = existsSync3(path) ? readText(path) : "";
  const problem = markerProblem(path, text);
  if (problem)
    throw new ValidationError(problem);
  const [head, block, tail] = splitManagedBlock(text);
  const tag = ruleTag(pattern);
  const kept = block.split(`
`).filter((line) => line.trim() && !line.replace(/\s+$/, "").endsWith(tag));
  kept.push(`${bullet} ${tag}`);
  writeFileSync2(path, `${head}${RULE_START}
${kept.join(`
`)}
${RULE_END}${tail}`, "utf8");
}
function removeRuleBullet(path, pattern) {
  if (!existsSync3(path))
    return false;
  const text = readText(path);
  const tag = ruleTag(pattern);
  if (!text.includes(tag))
    return false;
  const problem = markerProblem(path, text);
  if (problem)
    throw new ValidationError(problem);
  const [head, block, tail] = splitManagedBlock(text);
  const kept = block.split(`
`).filter((line) => line.trim() && !line.replace(/\s+$/, "").endsWith(tag));
  const body = kept.length > 0 ? `
${kept.join(`
`)}
` : `
`;
  writeFileSync2(path, `${head}${RULE_START}${body}${RULE_END}${tail}`, "utf8");
  return true;
}
function splitManagedBlock(text) {
  const startAt = text.indexOf(RULE_START);
  const head = startAt === -1 ? text : text.slice(0, startAt);
  const rest = startAt === -1 ? "" : text.slice(startAt + RULE_START.length);
  const endAt = rest.indexOf(RULE_END);
  const block = endAt === -1 ? rest : rest.slice(0, endAt);
  const tail = endAt === -1 ? "" : rest.slice(endAt + RULE_END.length);
  return [head, block, tail];
}
var PLACEHOLDER_NOTE = /re-homed from '[a-z]+', awaiting a real draft/;
function placeholderBody(pattern, artifactType, oldType) {
  const note = `re-homed from '${oldType}', awaiting a real draft`;
  if (artifactType === "none")
    return "";
  if (artifactType === "hook") {
    return {
      pattern,
      event: "PreToolUse",
      gate: { always: true },
      once_per: "session",
      text: `TODO: ${note}`.slice(0, 400)
    };
  }
  if (artifactType === "rule")
    return `- TODO: ${note} (${pattern})`;
  return `---
name: ${pattern}
description: Use when TODO -- ${note}
---

## TODO

${note}.
`;
}
function isPlaceholderBody(artifactType, body) {
  if (!body)
    return false;
  if (artifactType === "hook") {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return false;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload))
      return false;
    const p = payload;
    const gate = p["gate"];
    const gateIsAlwaysTrue = gate !== null && typeof gate === "object" && !Array.isArray(gate) && Object.keys(gate).length === 1 && gate["always"] === true;
    return p["event"] === "PreToolUse" && gateIsAlwaysTrue && p["once_per"] === "session" && PLACEHOLDER_NOTE.test(String(p["text"] ?? ""));
  }
  if (artifactType === "skill" || artifactType === "agent") {
    return body.includes("description: Use when TODO -- ") && body.includes(`
## TODO
`) && PLACEHOLDER_NOTE.test(body);
  }
  if (artifactType === "rule") {
    return body.replace(/^\s+/, "").startsWith("- TODO: ") && PLACEHOLDER_NOTE.test(body);
  }
  return false;
}
// packages/curriculum/src/prompts.ts
var exports_prompts = {};
__export(exports_prompts, {
  DRAFTER_SYSTEM: () => DRAFTER_SYSTEM,
  FORCED_SUBJECT: () => FORCED_SUBJECT,
  GATE_VOCABULARY: () => GATE_VOCABULARY,
  JUDGE_SYSTEM: () => JUDGE_SYSTEM,
  MAX_SOURCE_CHARS: () => MAX_SOURCE_CHARS,
  SHAPES: () => SHAPES,
  agentShape: () => agentShape,
  boundedSources: () => boundedSources,
  draftMessages: () => draftMessages,
  hookShape: () => hookShape,
  judgeMessages: () => judgeMessages,
  parseDraft: () => parseDraft,
  parseVerdict: () => parseVerdict,
  ruleShape: () => ruleShape,
  skillShape: () => skillShape
});

// packages/nudges/src/index.ts
var exports_src = {};
__export(exports_src, {
  EVENTS: () => EVENTS,
  LOW_FREQUENCY_EVENTS: () => LOW_FREQUENCY_EVENTS,
  MAX_MATCH_LEN: () => MAX_MATCH_LEN,
  MAX_PATTERN_LEN: () => MAX_PATTERN_LEN,
  MAX_QUANTIFIED_GROUPS: () => MAX_QUANTIFIED_GROUPS,
  MAX_TEXT: () => MAX_TEXT,
  PREDICATES: () => PREDICATES,
  ROTATE_AT_BYTES: () => ROTATE_AT_BYTES2,
  ROTATE_KEEP_LINES: () => ROTATE_KEEP_LINES2,
  appendLine: () => appendLine2,
  claimMarker: () => claimMarker,
  dispatch: () => dispatch,
  evaluate: () => evaluate,
  gateTruth: () => gateTruth,
  hasNestedQuantifier: () => hasNestedQuantifier,
  isUnsafeRegex: () => isUnsafeRegex,
  lintNudge: () => lintNudge,
  loadNudges: () => loadNudges,
  loadNudgesDetailed: () => loadNudgesDetailed,
  readFires: () => readFires,
  runGateCorpus: () => runGateCorpus,
  splitTrigger: () => splitTrigger,
  unboundedBroadcastRule: () => unboundedBroadcastRule,
  unsafeRegexReason: () => unsafeRegexReason,
  validateGate: () => validateGate,
  withDirLock: () => withDirLock,
  writeBreadcrumb: () => writeBreadcrumb
});

// packages/nudges/src/dispatch.ts
import { readdirSync as readdirSync2 } from "fs";
import { join as join6 } from "path";

// packages/nudges/src/firelog.ts
import { createHash } from "crypto";
import { appendFileSync as appendFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync2, rmSync as rmSync2, statSync as statSync4, writeFileSync as writeFileSync3 } from "fs";
import { dirname as dirname4 } from "path";
var ROTATE_AT_BYTES2 = 10 * 1024 * 1024;
var ROTATE_KEEP_LINES2 = 5000;
var DEFAULT_STALE_MS = 2000;
var MIN_WAIT_MS = 200;
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function reclaimable(lockDir, staleMs) {
  let raw = null;
  try {
    raw = readFileSync2(`${lockDir}/pid`, "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0)
      return true;
    return !pidAlive(pid);
  }
  try {
    return Date.now() - statSync4(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}
function withDirLock(lockDir, fn, staleMs = DEFAULT_STALE_MS) {
  const giveUpAt = Date.now() + Math.max(staleMs, MIN_WAIT_MS);
  for (;; ) {
    let held = false;
    try {
      mkdirSync4(lockDir);
      held = true;
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
    }
    if (held) {
      try {
        writeFileSync3(`${lockDir}/pid`, `${process.pid}
`, "utf8");
      } catch {}
      break;
    }
    if (reclaimable(lockDir, staleMs)) {
      try {
        rmSync2(lockDir, { recursive: true, force: true });
      } catch {}
    }
    if (Date.now() > giveUpAt)
      throw new Error(`withDirLock: timed out waiting for ${lockDir}`);
    Bun.sleepSync(5);
  }
  try {
    return fn();
  } finally {
    rmSync2(lockDir, { recursive: true, force: true });
  }
}
function rotateIfNeeded(path, rotateAt, keep) {
  let size;
  try {
    size = statSync4(path).size;
  } catch {
    return;
  }
  if (size < rotateAt)
    return;
  const lines = readFileSync2(path, "utf8").split(`
`).filter((l) => l.length > 0);
  atomicWrite(path, lines.slice(-keep).join(`
`) + `
`);
}
function appendLine2(path, line, rotateAt = ROTATE_AT_BYTES2, keep = ROTATE_KEEP_LINES2) {
  try {
    mkdirSync4(dirname4(path), { recursive: true });
    withDirLock(`${path}.lockdir`, () => {
      rotateIfNeeded(path, rotateAt, keep);
      appendFileSync2(path, line.endsWith(`
`) ? line : `${line}
`, "utf8");
    });
  } catch {}
}
function markerSlug(raw) {
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `${safe}-${digest}`;
}
function claimMarker(sessionDir, name) {
  try {
    const markers = `${sessionDir}/nudge-markers`;
    mkdirSync4(markers, { recursive: true });
    const mark = `${markers}/${markerSlug(name)}`;
    if (existsSync4(mark))
      return false;
    writeFileSync3(mark, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function ts() {
  return new Date().toISOString();
}
function writeBreadcrumb(fireLog, sessionDir, kind, sessionId, event, extra = {}, dedupeKey) {
  if (!claimMarker(sessionDir, `breadcrumb-${dedupeKey ?? `${kind}-${event}`}`))
    return;
  const record = { ts: ts(), kind, session_id: sessionId, event, ...extra };
  appendLine2(fireLog, JSON.stringify(record));
}
function readFires(path) {
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(`
`)) {
    const t = line.trim();
    if (!t)
      continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v))
        out.push(v);
    } catch {}
  }
  return out;
}

// packages/nudges/src/gates.ts
var MAX_MATCH_LEN = 4000;
var MAX_PATTERN_LEN = 200;
var MAX_QUANTIFIED_GROUPS = 3;
var EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"]),
  PostToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"])
};
var LOW_FREQUENCY_EVENTS = new Set(["SessionStart"]);
var PREDICATES = new Set([
  "always",
  "tool_is",
  "command_matches",
  "file_path_matches",
  "prompt_matches",
  "all",
  "any",
  "not"
]);
function splitTrigger(trigger) {
  const idx = trigger.indexOf(":");
  const event = idx === -1 ? trigger : trigger.slice(0, idx);
  const matcher = idx === -1 ? null : trigger.slice(idx + 1);
  if (!Object.hasOwn(EVENTS, event))
    return null;
  const allowed = EVENTS[event];
  if (!matcher)
    return [event, null];
  if (allowed === null || !allowed.has(matcher))
    return null;
  return [event, matcher];
}
var RISKY_GROUP_BODY = /[|+*?{]/;
var BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;
function quantifiedGroupBodies(pattern) {
  const bodies = [];
  const open = [];
  let inClass = false;
  for (let i = 0;i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]")
        inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      open.push(i);
      continue;
    }
    if (c !== ")")
      continue;
    const start = open.pop();
    if (start === undefined)
      continue;
    const next = pattern[i + 1];
    const quantified = next === "+" || next === "*" || next === "{" && BRACE_QUANTIFIER.test(pattern.slice(i + 1));
    if (quantified)
      bodies.push(pattern.slice(start + 1, i));
  }
  return bodies;
}
function unsafeRegexReason(pattern) {
  if (pattern.length > MAX_PATTERN_LEN) {
    return `is ${pattern.length} chars; the cap is ${MAX_PATTERN_LEN}`;
  }
  const bodies = quantifiedGroupBodies(pattern);
  if (bodies.length > MAX_QUANTIFIED_GROUPS) {
    return `has ${bodies.length} quantified groups; the cap is ${MAX_QUANTIFIED_GROUPS}`;
  }
  const risky = bodies.find((b) => RISKY_GROUP_BODY.test(b));
  if (risky !== undefined) {
    return `has a quantified group ${JSON.stringify(`(${risky})`)} that can backtrack ` + `catastrophically (e.g. (a+)+, (a|aa)+); rewrite it without a quantifier, ` + `alternation or optional inside a quantified group`;
  }
  return null;
}
function isUnsafeRegex(pattern) {
  return unsafeRegexReason(pattern) !== null;
}
var hasNestedQuantifier = isUnsafeRegex;
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function command(payload) {
  const ti = payload["tool_input"];
  return isRecord(ti) && typeof ti["command"] === "string" ? ti["command"] : "";
}
function filePath(payload) {
  const ti = payload["tool_input"];
  return isRecord(ti) && typeof ti["file_path"] === "string" ? ti["file_path"] : "";
}
function matchClass(pattern, start, ch) {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i++;
  }
  const first = i;
  let matched = false;
  while (i < pattern.length) {
    if (pattern[i] === "]" && i > first)
      break;
    if (pattern[i + 1] === "-" && i + 2 < pattern.length && pattern[i + 2] !== "]") {
      if (ch >= pattern[i] && ch <= pattern[i + 2])
        matched = true;
      i += 3;
      continue;
    }
    if (pattern[i] === ch)
      matched = true;
    i++;
  }
  if (i >= pattern.length)
    return null;
  return { end: i + 1, matched: negate ? !matched : matched };
}
function fnmatch(path, pattern) {
  let si = 0;
  let pi = 0;
  let starSi = -1;
  let starPi = -1;
  while (si < path.length) {
    const pc = pattern[pi];
    if (pc === "*") {
      starPi = pi;
      starSi = si;
      pi++;
      continue;
    }
    let ok = false;
    if (pc === "?") {
      ok = true;
      pi++;
    } else if (pc === "[") {
      const cls = matchClass(pattern, pi, path[si]);
      if (cls === null) {
        ok = path[si] === "[";
        pi++;
      } else {
        ok = cls.matched;
        pi = cls.end;
      }
    } else if (pc !== undefined && pc === path[si]) {
      ok = true;
      pi++;
    }
    if (ok) {
      si++;
      continue;
    }
    if (starPi === -1)
      return false;
    starSi++;
    si = starSi;
    pi = starPi + 1;
  }
  while (pattern[pi] === "*")
    pi++;
  return pi === pattern.length;
}
function search(pattern, text) {
  if (typeof pattern !== "string")
    return false;
  try {
    return new RegExp(pattern).test(text.slice(0, MAX_MATCH_LEN));
  } catch {
    return false;
  }
}
function evaluateInner(gate, payload) {
  if (!isRecord(gate))
    return false;
  const keys = Object.keys(gate);
  if (keys.length !== 1)
    return false;
  const name = keys[0];
  const arg = gate[name];
  switch (name) {
    case "always":
      return true;
    case "tool_is":
      return Array.isArray(arg) && arg.includes(payload["tool_name"]);
    case "command_matches":
      return search(arg, command(payload));
    case "file_path_matches": {
      if (typeof arg !== "string")
        return false;
      const path = filePath(payload).slice(0, MAX_MATCH_LEN);
      return path !== "" && fnmatch(path, arg);
    }
    case "prompt_matches":
      return search(arg, typeof payload["prompt"] === "string" ? payload["prompt"] : "");
    case "all":
      return Array.isArray(arg) && arg.every((g) => evaluateInner(g, payload));
    case "any":
      return Array.isArray(arg) && arg.some((g) => evaluateInner(g, payload));
    case "not":
      return !evaluateInner(arg, payload);
    default:
      return false;
  }
}
function evaluate(gate, payload) {
  try {
    return evaluateInner(gate, payload);
  } catch {
    return false;
  }
}
function validateGate(gate) {
  const problems = [];
  if (!isRecord(gate)) {
    problems.push(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
    return problems;
  }
  const keys = Object.keys(gate);
  if (keys.length !== 1) {
    problems.push(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
    return problems;
  }
  const name = keys[0];
  const arg = gate[name];
  if (!PREDICATES.has(name)) {
    problems.push(`unknown predicate ${JSON.stringify(name)}; allowed: ${[...PREDICATES].sort().join(", ")}`);
    return problems;
  }
  const checkRegex = (label) => {
    if (typeof arg !== "string") {
      problems.push(`${label} takes a regex string`);
      return;
    }
    try {
      new RegExp(arg);
    } catch (e) {
      problems.push(`${label} has bad regex ${JSON.stringify(arg)}: ${e.message}`);
      return;
    }
    const reason = unsafeRegexReason(arg);
    if (reason !== null) {
      problems.push(`${label} regex ${JSON.stringify(arg.slice(0, MAX_PATTERN_LEN))} ${reason}`);
    }
  };
  switch (name) {
    case "always":
      break;
    case "tool_is":
      if (!Array.isArray(arg))
        problems.push("tool_is takes a list of tool names");
      break;
    case "command_matches":
      checkRegex("command_matches");
      break;
    case "file_path_matches":
      if (typeof arg !== "string")
        problems.push("file_path_matches takes a glob string");
      else if (arg.length > MAX_PATTERN_LEN)
        problems.push(`file_path_matches glob is ${arg.length} chars; the cap is ${MAX_PATTERN_LEN}`);
      break;
    case "prompt_matches":
      checkRegex("prompt_matches");
      break;
    case "all":
    case "any":
      if (!Array.isArray(arg)) {
        problems.push(`${name} takes a list of predicates`);
      } else {
        for (const child of arg)
          problems.push(...validateGate(child));
      }
      break;
    case "not":
      problems.push(...validateGate(arg));
      break;
  }
  return problems;
}
function gateTruth(gate) {
  if (!isRecord(gate))
    return null;
  const keys = Object.keys(gate);
  if (keys.length !== 1)
    return null;
  const name = keys[0];
  const arg = gate[name];
  switch (name) {
    case "always":
      return true;
    case "tool_is":
      return Array.isArray(arg) && arg.length === 0 ? false : null;
    case "command_matches":
    case "prompt_matches":
      return arg === "" ? true : null;
    case "all": {
      if (!Array.isArray(arg))
        return null;
      const truths = arg.map(gateTruth);
      if (truths.some((t) => t === false))
        return false;
      return truths.every((t) => t === true) ? true : null;
    }
    case "any": {
      if (!Array.isArray(arg))
        return null;
      const truths = arg.map(gateTruth);
      if (truths.some((t) => t === true))
        return true;
      return truths.every((t) => t === false) ? false : null;
    }
    case "not": {
      const inner = gateTruth(arg);
      return inner === null ? null : !inner;
    }
    default:
      return null;
  }
}

// packages/nudges/src/lint.ts
var MAX_TEXT = 400;
var ONCE_PER = new Set(["session", "always"]);
function unboundedBroadcastRule() {
  const low = [...LOW_FREQUENCY_EVENTS].sort().join(", ");
  return "a gate that is true for every payload is accepted only when " + "something else bounds it: set 'once_per' to 'session', or use " + `one of the low-frequency events (${low}). An unconditional gate ` + "with 'once_per' set to 'always' on any other event is rejected outright";
}
function lintUnboundedBroadcast(obj) {
  if (gateTruth(obj.gate) !== true)
    return [];
  if (obj.once_per === "session")
    return [];
  if (LOW_FREQUENCY_EVENTS.has(obj.event))
    return [];
  return [
    `degenerate gate: it fires unconditionally, once_per is ` + `${JSON.stringify(obj.once_per)}, and ${obj.event} fires many times per ` + `session, this injects on every ${obj.event} forever and ` + `discriminates nothing. Narrow the gate to a real predicate, or ` + unboundedBroadcastRule()
  ];
}
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function lintNudge(obj) {
  if (!isRecord2(obj))
    return ["nudge must be a JSON object"];
  const problems = [];
  for (const field of ["pattern", "event", "gate", "once_per", "text"]) {
    if (!(field in obj))
      problems.push(`missing required field ${JSON.stringify(field)}`);
  }
  if (problems.length > 0)
    return problems;
  if (typeof obj["pattern"] !== "string")
    problems.push("field 'pattern' must be a string");
  else if (!isSlug(obj["pattern"]))
    problems.push(`field 'pattern' must be a slug, got ${JSON.stringify(obj["pattern"])}`);
  if (typeof obj["event"] !== "string")
    problems.push("field 'event' must be a string");
  if (!isRecord2(obj["gate"]))
    problems.push("field 'gate' must be a dict");
  if (typeof obj["once_per"] !== "string")
    problems.push("field 'once_per' must be a string");
  if (typeof obj["text"] !== "string")
    problems.push("field 'text' must be a string");
  if (obj["matcher"] !== undefined && obj["matcher"] !== null && typeof obj["matcher"] !== "string") {
    problems.push("field 'matcher' must be a string or absent");
  }
  if (problems.length > 0)
    return problems;
  const event = obj["event"];
  const matcher = obj["matcher"];
  const text = obj["text"];
  const oncePer = obj["once_per"];
  const trigger = event + (matcher ? `:${matcher}` : "");
  const triggerOk = splitTrigger(trigger) !== null;
  if (!triggerOk)
    problems.push(`unsupported event/matcher: ${JSON.stringify(trigger)}`);
  const oncePerOk = ONCE_PER.has(oncePer);
  if (!oncePerOk)
    problems.push(`once_per must be one of ${[...ONCE_PER].sort().join(", ")}`);
  if (!text.trim())
    problems.push("text must be a non-empty string");
  else if (text.length > MAX_TEXT)
    problems.push(`text is ${text.length} chars; the cap is ${MAX_TEXT}`);
  problems.push(...validateGate(obj["gate"]));
  if (triggerOk && oncePerOk) {
    problems.push(...lintUnboundedBroadcast({
      pattern: obj["pattern"],
      event,
      gate: obj["gate"],
      once_per: oncePer,
      text,
      matcher
    }));
  }
  return problems;
}

// packages/nudges/src/dispatch.ts
var DEFAULT_BUDGET_MS = 250;
var DEFAULT_GATE_TIMEOUT_MS = 50;
var GATE_MIN_SLICE_MS = 5;
function isRecord3(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function loadNudgesDetailed(dirs) {
  const nudges = [];
  const rejected = [];
  for (const d of dirs) {
    let names;
    try {
      names = readdirSync2(d).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join6(d, name);
      const raw = readJsonOr(file, null);
      if (!isRecord3(raw)) {
        rejected.push({ file, problems: ["not readable as a JSON object"] });
        continue;
      }
      const problems = lintNudge(raw);
      if (problems.length > 0) {
        rejected.push({ file, problems });
        continue;
      }
      nudges.push(raw);
    }
  }
  return { nudges, rejected };
}
function loadNudges(dirs) {
  return loadNudgesDetailed(dirs).nudges;
}
function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function dispatch(payload, nudges, opts) {
  try {
    const sessionId = str(payload["session_id"], "unknown");
    const event = str(payload["hook_event_name"]);
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    let gateSpentMs = 0;
    let scanned = 0;
    let budgetExhausted = false;
    for (const nudge of nudges) {
      scanned++;
      if (!isRecord3(nudge) || nudge["event"] !== event)
        continue;
      const matcher = nudge["matcher"];
      if (matcher && payload["tool_name"] !== matcher)
        continue;
      const remaining = budgetMs - gateSpentMs;
      if (remaining < GATE_MIN_SLICE_MS) {
        budgetExhausted = true;
        break;
      }
      const started = performance.now();
      const matched = evaluate(nudge["gate"], payload);
      const elapsedMs = performance.now() - started;
      gateSpentMs += elapsedMs;
      const pattern = str(nudge["pattern"], "unknown");
      if (elapsedMs > gateTimeoutMs) {
        writeBreadcrumb(opts.fireLog, opts.sessionDir, "gate_overrun", sessionId, event, {
          pattern,
          elapsed_ms: Math.round(elapsedMs),
          budget_ms: gateTimeoutMs
        });
      }
      if (!matched)
        continue;
      if (nudge["once_per"] !== "always") {
        if (!claimMarker(opts.sessionDir, `nudge-${pattern}`))
          continue;
      }
      appendLine2(opts.fireLog, JSON.stringify({ ts: new Date().toISOString(), pattern, session_id: sessionId, event }));
      return str(nudge["text"]);
    }
    if (budgetExhausted) {
      writeBreadcrumb(opts.fireLog, opts.sessionDir, "gate_budget_exhausted", sessionId, event, { scanned });
    }
    return null;
  } catch {
    return null;
  }
}
// packages/nudges/src/gate-runner.ts
import { existsSync as existsSync5 } from "fs";
import { join as join7 } from "path";
function isRecord4(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function resolveRunner() {
  const built = join7(pluginRoot(), "dist", "gate-runner.js");
  if (existsSync5(built))
    return built;
  return join7(pluginRoot(), "packages", "nudges", "src", "gate-runner.ts");
}
function runGateCorpus(gate, payloads, timeoutMs = 250) {
  const runner = resolveRunner();
  const input = JSON.stringify({ gate, payloads });
  let proc;
  try {
    proc = Bun.spawnSync(["bun", runner], { stdin: Buffer.from(input, "utf8"), stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  } catch (e) {
    return { results: null, error: e.message, timedOut: false };
  }
  if (proc.exitCode === null) {
    return { results: null, error: `gate corpus evaluation exceeded ${timeoutMs}ms`, timedOut: true };
  }
  const out = (proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  try {
    const parsed = JSON.parse(out);
    if (isRecord4(parsed) && typeof parsed["error"] === "string") {
      return { results: null, error: parsed["error"], timedOut: false };
    }
    if (isRecord4(parsed) && Array.isArray(parsed["results"])) {
      return { results: parsed["results"], error: null, timedOut: false };
    }
    return { results: null, error: `unexpected gate-runner output: ${out.slice(0, 200)}`, timedOut: false };
  } catch {
    return { results: null, error: `unparseable gate-runner output: ${out.slice(0, 200)}`, timedOut: false };
  }
}
if (false) {}
// packages/curriculum/src/deps.ts
var override = null;
function setNudgeAdapter(adapter) {
  override = adapter;
}
function fromPackage() {
  const ns = exports_src;
  const out = {};
  if (ns["EVENTS"])
    out.EVENTS = ns["EVENTS"];
  if (typeof ns["lintNudge"] === "function")
    out.lintNudge = ns["lintNudge"];
  if (typeof ns["runGateCorpus"] === "function")
    out.runGateCorpus = ns["runGateCorpus"];
  return out;
}
function nudges() {
  return override ?? fromPackage();
}
function nudgeEvents() {
  return nudges().EVENTS ?? null;
}

// packages/curriculum/src/lint.ts
var MAX_DESCRIPTION = 500;
var MAX_SENTENCES = 2;
var MAX_RULE_CHARS = 300;
var MIN_BODY_CHARS = 80;
var MIN_SHARED_TERMS = 4;
var FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
var TRIGGER_RE = /(use when|trigger)/i;
var SECRET_RE = /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,})/i;
var PLACEHOLDER_RE = /<[A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)+>/g;
var SCAFFOLD_MARKERS = [
  "source reflections:",
  "now write the real one",
  "both '---' delimiter lines",
  "must begin with 'use when'",
  "existing skill to refine:",
  "existing artifact to refine:",
  "lessons to generalise:",
  "decide what kind of claude code artifact",
  "copy the structure, never the wording",
  "write the first one that applies"
];
var SENTENCE_END = /[.!?](?:\s|$)/g;
var ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|cf|al)\./gi;
var WORD_RE = /[a-z][a-z0-9_-]{4,}/g;
var GENERIC = new Set(`about above after again against always because before being below between both
check checks claim could doing during evidence every first further given having
however itself might other properly should since their there these things think
those through under until using verify whether which while would your result
results ensure ensures never making makes made`.split(/\s+/).filter(Boolean));
var RULE_TAG_OPEN2 = ruleTag("").replace("-->", "");
var headingWords = null;
function templateWords() {
  if (headingWords === null) {
    headingWords = new Set;
    for (const heading of SECTIONS) {
      for (const word of heading.toLowerCase().match(WORD_RE) ?? [])
        headingWords.add(word);
    }
  }
  return headingWords;
}
function payloadText(payload) {
  if (typeof payload === "string")
    return payload;
  try {
    return JSON.stringify(payload, sortedReplacer(payload)) ?? String(payload);
  } catch {
    return String(payload);
  }
}
function sortedReplacer(_root) {
  return (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const out = {};
      for (const k of Object.keys(value).sort())
        out[k] = value[k];
      return out;
    }
    return value;
  };
}
function field(name, frontMatter) {
  for (const line of frontMatter.split(`
`)) {
    if (line.toLowerCase().startsWith(name + ":"))
      return line.slice(line.indexOf(":") + 1).trim();
  }
  return null;
}
function countSentences(desc) {
  return (desc.trim().replace(ABBREVIATION, "").match(SENTENCE_END) ?? []).length;
}
function lintDescriptionCap(desc) {
  const problems = [];
  if (desc.length > MAX_DESCRIPTION) {
    problems.push(`\`description\` is ${desc.length} chars; the cap is ${MAX_DESCRIPTION}. A trigger is one situation, not a disjunction of twenty.`);
  }
  const n = countSentences(desc);
  if (n > MAX_SENTENCES)
    problems.push(`\`description\` has ${n} sentences; the cap is ${MAX_SENTENCES}`);
  return problems;
}
function distinctiveTerms(text) {
  const excluded = new Set([...GENERIC, ...templateWords()]);
  const out = new Set;
  for (const w of (text ?? "").toLowerCase().match(WORD_RE) ?? [])
    if (!excluded.has(w))
      out.add(w);
  return out;
}
function lintGrounding(body, sourcesText, minShared = MIN_SHARED_TERMS) {
  const bodyTerms = distinctiveTerms(body);
  const shared = [...distinctiveTerms(sourcesText)].filter((w) => bodyTerms.has(w)).sort();
  if (shared.length < minShared) {
    return [
      `body not grounded in its sources: only ${shared.length} distinctive term(s) shared (${JSON.stringify(shared)}); reads as generic filler`
    ];
  }
  return [];
}
function lintSkill(text, pattern, minBodyChars = MIN_BODY_CHARS) {
  const problems = [];
  const match = FRONTMATTER.exec(text ?? "");
  if (!match)
    return ["missing or malformed frontmatter (--- ... --- at top of file)"];
  const frontMatter = match[1];
  const body = match[2];
  const name = field("name", frontMatter);
  if (!name)
    problems.push("frontmatter missing non-empty `name`");
  else if (name !== pattern) {
    problems.push(`frontmatter \`name\` (${JSON.stringify(name)}) must equal the pattern (${JSON.stringify(pattern)})`);
  }
  const desc = field("description", frontMatter);
  if (!desc)
    problems.push("frontmatter missing non-empty `description`");
  else if (!TRIGGER_RE.test(desc)) {
    problems.push("`description` must read as a trigger (contain 'Use when' or 'Trigger')");
  } else {
    problems.push(...lintDescriptionCap(desc));
  }
  if (body.trim().length < minBodyChars)
    problems.push(`body too short (< ${minBodyChars} non-whitespace chars)`);
  for (const placeholder of [...new Set(text.match(PLACEHOLDER_RE) ?? [])]) {
    problems.push(`unreplaced template placeholder: ${placeholder}`);
  }
  const low = text.toLowerCase();
  for (const marker of SCAFFOLD_MARKERS) {
    if (low.includes(marker))
      problems.push(`drafting-prompt scaffolding echoed into the artifact: ${JSON.stringify(marker)}`);
  }
  return problems;
}
function lintRule(text, pattern = null) {
  const lines = (text ?? "").trim().split(`
`).filter((line) => line.trim());
  if (lines.length !== 1)
    return [`a rule is exactly one bullet; got ${lines.length} line(s)`];
  const line = lines[0].trim();
  const problems = [];
  if (!line.startsWith("- "))
    problems.push("a rule must start with '- '");
  for (const marker of [RULE_START, RULE_END, RULE_TAG_OPEN2]) {
    if (line.includes(marker)) {
      problems.push(`rule contains the managed-block marker ${JSON.stringify(marker)}; writing it would make the rules file unreadable and unretireable`);
    }
  }
  const tag = pattern ? ruleTag(pattern) : "";
  const total = line.length + (tag ? 1 + tag.length : 0);
  if (total > MAX_RULE_CHARS) {
    const detail = tag ? ` once its ${tag} tag is appended` : "";
    problems.push(`rule is ${total} chars${detail}; the cap is ${MAX_RULE_CHARS}`);
  }
  return problems;
}
function lintHook(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return ["hook artifact must be a JSON object"];
  }
  const fn = nudges().lintNudge;
  if (!fn)
    return ["nudge dispatcher unavailable, cannot lint a hook"];
  try {
    return [...fn(payload)];
  } catch (e) {
    return [`nudge dispatcher unavailable, cannot lint a hook: ${e.message}`];
  }
}
var typeName = (v) => Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "object" ? "dict" : typeof v;
function lint(artifactType, payload, pattern, sourcesText) {
  if (artifactType === "none")
    return [];
  let problems;
  let body;
  if (artifactType === "hook") {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return ["hook artifact must be a JSON object"];
    }
    const obj = payload;
    problems = lintHook(obj);
    if (obj["pattern"] !== pattern) {
      problems.push(`hook \`pattern\` (${JSON.stringify(obj["pattern"] ?? null)}) must equal the artifact's pattern (${JSON.stringify(pattern)})`);
    }
    body = String(obj["text"] ?? "");
  } else if (artifactType === "rule") {
    if (typeof payload !== "string")
      return [`rule artifact must be text, not ${typeName(payload)}`];
    problems = lintRule(payload, pattern);
    body = payload;
  } else if (artifactType === "skill" || artifactType === "agent") {
    if (typeof payload !== "string")
      return [`${artifactType} artifact must be text, not ${typeName(payload)}`];
    problems = lintSkill(payload, pattern);
    body = payload;
  } else {
    return [`unknown artifact type ${JSON.stringify(artifactType)}`];
  }
  if (SECRET_RE.test(payloadText(payload))) {
    problems.push("possible secret or token detected; refusing to promote");
  }
  problems.push(...lintGrounding(body, sourcesText));
  return problems;
}

// packages/curriculum/src/router.ts
var GATE_TIMEOUT_MS = 250;
var MIN_QUOTE_WORDS = 5;
var MIN_QUOTE_CHARS = 30;
var MIN_QUOTE_TERMS = 3;
var RouteAnswer = object({
  trigger_event: string2().default("none"),
  gate: record(string2(), unknown()).nullable().default(null),
  needs_own_context: boolean2().default(false),
  context_evidence: string2().nullable().default(null),
  capability_evidence: string2().nullable().default(null),
  no_artifact: boolean2().default(false),
  parse_error: string2().default("")
});
var emptyAnswer = () => RouteAnswer.parse({});
function splitTrigger2(trigger) {
  const events = nudgeEvents();
  if (!events)
    return null;
  const raw = String(trigger ?? "");
  const at = raw.indexOf(":");
  const event = at === -1 ? raw : raw.slice(0, at);
  const matcher = at === -1 ? "" : raw.slice(at + 1);
  if (!Object.hasOwn(events, event))
    return null;
  const allowed = events[event];
  if (!matcher)
    return [event, null];
  if (allowed === null || allowed === undefined || !allowed.has(matcher))
    return null;
  return [event, matcher];
}
function normalise(text) {
  return text.split(/\s+/).filter(Boolean).join(" ");
}
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var SECTION_HEADINGS = new Set(SECTIONS.map((heading) => heading.trim()));
var TEMPLATE_LINE = /^(Pattern|Last updated):/;
function withoutScaffolding(text) {
  return text.split(`
`).filter((line) => {
    const trimmed = line.trim();
    return !TEMPLATE_LINE.test(trimmed) && !SECTION_HEADINGS.has(trimmed);
  }).join(`
`);
}
function substantiveQuote(note, sourcesText) {
  const quote = normalise(note ?? "");
  if (quote.length < MIN_QUOTE_CHARS || quote.split(" ").filter(Boolean).length < MIN_QUOTE_WORDS)
    return false;
  if (distinctiveTerms(quote).size < MIN_QUOTE_TERMS)
    return false;
  const haystack = normalise(withoutScaffolding(sourcesText ?? ""));
  return new RegExp(`(?<!\\w)${escapeRe(quote)}(?!\\w)`).test(haystack);
}
function route(answer, sourcesText, payloads, opts = {}) {
  const reply = RouteAnswer.safeParse(answer).data ?? emptyAnswer();
  const sources = typeof sourcesText === "string" ? sourcesText : "";
  const corpus = Array.isArray(payloads) ? payloads : [];
  if (reply.parse_error) {
    return { artifact_type: "none", reason: `unreadable drafter reply: ${reply.parse_error}` };
  }
  if (reply.no_artifact) {
    return { artifact_type: "none", reason: "drafter declined: no artifact warranted" };
  }
  const hookReason = whyNotHook(reply, corpus, opts);
  if (hookReason === null) {
    return { artifact_type: "hook", reason: `gate fires on the payload corpus at ${reply.trigger_event}` };
  }
  if (reply.needs_own_context) {
    const note = (reply.context_evidence ?? "").trim();
    if (!note) {
      return {
        artifact_type: "rule",
        reason: "needs_own_context asserted with no context_evidence; an unevidenced boolean does not buy an agent"
      };
    }
    if (!substantiveQuote(note, sources)) {
      return {
        artifact_type: "rule",
        reason: `context_evidence is not verbatim in any source reflection (needs at least ${MIN_QUOTE_WORDS} words, ` + `${MIN_QUOTE_CHARS} characters and ${MIN_QUOTE_TERMS} distinctive terms, matched on word boundaries ` + "against the sources with the reflection template's own lines removed); treated as a discipline"
      };
    }
    return { artifact_type: "agent", reason: "own-context need quoted verbatim from a source" };
  }
  const quote = (reply.capability_evidence ?? "").trim();
  if (quote) {
    if (substantiveQuote(quote, sources)) {
      return { artifact_type: "skill", reason: "capability evidence quoted verbatim from a source" };
    }
    return {
      artifact_type: "rule",
      reason: `capability_evidence is not verbatim in any source reflection (needs at least ${MIN_QUOTE_WORDS} words, ` + `${MIN_QUOTE_CHARS} characters and ${MIN_QUOTE_TERMS} distinctive terms, matched on word boundaries ` + "against the sources with the reflection template's own lines removed); treated as a discipline"
    };
  }
  return {
    artifact_type: "rule",
    reason: `no workable gate (${hookReason}), no own-context need, no capability evidence`
  };
}
function whyNotHook(answer, payloads, opts) {
  const gate = answer.gate;
  if (answer.trigger_event === "none" || gate == null || Object.keys(gate).length === 0) {
    return "no trigger event proposed";
  }
  if (splitTrigger2(answer.trigger_event) === null) {
    return `unsupported event/matcher ${JSON.stringify(answer.trigger_event)}`;
  }
  if (payloads.length === 0)
    return "no recorded payloads to test the gate against";
  const runner = opts.gateRunner ?? nudges().runGateCorpus;
  if (!runner)
    return "nudge dispatcher unavailable: no gate runner";
  const timeoutMs = opts.timeoutMs ?? GATE_TIMEOUT_MS;
  let outcome;
  try {
    outcome = runner(gate, payloads, timeoutMs);
  } catch (e) {
    return `gate runner raised ${e.name || "Error"}`;
  }
  if (outcome.timedOut)
    return `gate evaluation timed out after ${timeoutMs}ms`;
  if (outcome.error)
    return `gate rejected: ${outcome.error}`;
  const results = Array.isArray(outcome.results) ? outcome.results : [];
  if (results.length !== payloads.length) {
    return `gate runner answered for ${results.length} of ${payloads.length} payload(s)`;
  }
  if (!results.some(Boolean))
    return "gate matched nothing in the payload corpus";
  if (results.every(Boolean) && payloads.length > 1) {
    return "gate fires on every payload in the corpus; that is a broadcast";
  }
  return null;
}

// packages/curriculum/src/prompts.ts
var MAX_SOURCE_CHARS = 200000;
var FENCE_RE = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```\s*$/;
var THINK_RE = /^\s*<think>[\s\S]*?<\/think>\s*/i;
function boundedSources(lessons) {
  const kept = [];
  let total = 0;
  for (const raw of [...lessons].reverse()) {
    const text = (raw ?? "").trim();
    if (total + text.length > MAX_SOURCE_CHARS && kept.length > 0)
      break;
    kept.push(text);
    total += text.length;
  }
  kept.reverse();
  if (kept.length < lessons.length) {
    kept.unshift(`[${lessons.length - kept.length} older reflection(s) omitted to fit the drafting context; the ${kept.length} most recent of ${lessons.length} are included]`);
  }
  return kept.join(`

---

`);
}
function skillShape(pattern) {
  return "A markdown file. Line 1 is three hyphens alone. Then a line 'name:' " + `followed by exactly ${pattern}. Then a line 'description:' followed by ` + "'Use when ' and one specific trigger situation drawn from the lessons " + "below, at most two sentences. Then three hyphens alone on their own " + "line. Then a markdown '## ' heading naming the action to take, then the " + "guidance: imperative, specific, over 80 characters, naming the actual " + "commands, fields or checks the lessons name.";
}
function agentShape(pattern) {
  return "The same file shape as a skill: three hyphens alone, a line 'name:' " + `followed by exactly ${pattern}, a line 'description:' followed by 'Use ` + "when ' and one specific trigger situation, then three hyphens alone. " + "Then a markdown '## ' heading, then the sub-agent's brief: what it " + "investigates, what it must read, what it reports back. Over 80 " + "characters, naming the actual commands, fields or checks the lessons name.";
}
function ruleShape(pattern) {
  const budget = MAX_RULE_CHARS - ruleTag(pattern).length - 1;
  return `Exactly one line, starting with '- ', at most ${budget} characters. No heading, ` + "no frontmatter, no second line: the single imperative the agent must " + "follow, naming the actual command or check the lessons name. No HTML " + "comment and no '<!--rule:...-->' tag: the writer adds the tag itself.";
}
var GATE_VOCABULARY = {
  always: "taking true, which fires on every matching call",
  tool_is: "taking a list of tool names",
  command_matches: "taking a regex string, matched against the Bash command",
  file_path_matches: "taking a glob string, matched against the file path",
  prompt_matches: "taking a regex string, matched against the user's prompt",
  all: "taking a list of predicates, true when every one of them is true",
  any: "taking a list of predicates, true when at least one is true",
  not: "taking a single predicate and inverting it"
};
function eventVocabulary() {
  const events = nudgeEvents();
  if (!events) {
    return [
      "PreToolUse, PostToolUse, Stop, SessionStart, UserPromptSubmit",
      "Bash, Edit, Write, Read, Grep, Glob, Agent"
    ];
  }
  const matchers = new Set;
  for (const allowed of Object.values(events)) {
    if (allowed)
      for (const m of allowed)
        matchers.add(m);
  }
  return [Object.keys(events).sort().join(", "), [...matchers].sort().join(", ")];
}
function hookShape(pattern) {
  const [events, matchers] = eventVocabulary();
  const vocab = Object.keys(GATE_VOCABULARY).sort().map((name) => `'${name}' ${GATE_VOCABULARY[name]}`).join("; ");
  return "A JSON object. Its keys: " + `'pattern', exactly ${pattern}; ` + `'event', exactly one of: ${events}; ` + `'matcher', only meaningful for PreToolUse and PostToolUse, one of: ${matchers}; omit the key entirely to match every tool; ` + "'gate', an object holding exactly ONE predicate, named only from this " + `closed vocabulary and never invented or substituted: ${vocab}. ` + "No predicate can read your own reply, so gate on the tool call that comes " + "before the mistake, not on the sentence that states it. The gate must be " + "narrow: one that fires on every tool call is a broadcast and is refused. " + "'once_per', either 'session' or 'always'; " + "'text', the nudge shown to the agent: imperative, specific, under 400 " + "characters, naming the actual commands or checks the lessons name.";
}
var SHAPES = {
  skill: skillShape,
  agent: agentShape,
  rule: ruleShape,
  hook: hookShape
};
var FORCED_SUBJECT = {
  skill: "Claude Code SKILL.md",
  agent: "Claude Code sub-agent definition",
  rule: "one-line rule bullet",
  hook: "Claude Code hook nudge (a JSON object)"
};
var ROUTING_FIELDS = 'trigger_event is "none", or "<HookEventName>:<Matcher>" (for example ' + '"PreToolUse:Bash") naming a real Claude Code hook event this lesson could ' + "be checked against mechanically on every matching tool call. gate is a " + "single-predicate object usable by the nudge dispatcher, or null if no gate " + "applies. needs_own_context is true only if acting on this lesson needs its " + "own agent and budget rather than a reminder, and when it is true " + "context_evidence MUST be an exact substring copied verbatim from the lessons " + `below that shows that need, at least ${MIN_QUOTE_WORDS} words and ` + `${MIN_QUOTE_CHARS} characters long, starting and ending at a word boundary. ` + `It must carry at least ${MIN_QUOTE_TERMS} words specific to this lesson: a date, a ` + "Pattern line or a section heading is not a quote. Without that quote the lesson is treated as a " + "discipline rather than an agent. capability_evidence, if set, MUST be an " + "exact substring copied verbatim from the lessons below, never paraphrased, " + "under the same length rule, naming a concrete thing the agent can actually " + "do that neither a hook nor a rule can express. no_artifact is true only if no " + "artifact at all is warranted.";
var DRAFTER_SYSTEM = "You write Claude Code artifacts from recurring lessons. You reply with one " + "JSON object and nothing else: no prose, no code fence, no <think> block.";
var JUDGE_SYSTEM = "You are the last gate before an artifact is committed and starts changing an " + "agent's behaviour. You reply with one JSON object and nothing else.";
function draftMessages(pattern, lessons, existing = null, artifactType = null) {
  const sources = boundedSources(lessons);
  const tail = existing ? `

Existing artifact to refine:
${existing}` : "";
  let user;
  if (artifactType !== null && artifactType in SHAPES) {
    user = `${existing ? "Refine the existing" : "Write a"} ` + `${FORCED_SUBJECT[artifactType]} for the recurring lesson ` + `'${pattern}'. Its type is already decided; do not re-decide it.

` + 'Reply with a JSON object holding exactly one key, "artifact". Its ' + `value is ${artifactType === "hook" ? "an object" : "a string"} in this shape:
` + SHAPES[artifactType](pattern) + `

Do not restate this task, do not add commentary, do not leave ` + `angle-bracket fill-ins, do not include secrets or tokens.

` + `Lessons to generalise:

` + sources + tail;
  } else {
    user = "Decide what kind of Claude Code artifact the recurring lesson " + `'${pattern}' should become, then write that artifact.

` + "Reply with one JSON object with these keys: trigger_event, gate, " + "needs_own_context, context_evidence, capability_evidence, no_artifact, " + `artifact.

` + ROUTING_FIELDS + `

` + '"artifact" is the body, and WHICH body is decided by the routing ' + "fields you just wrote. Work through these in order and write the " + `first one that applies, and only that one:
` + `1. no_artifact is true: artifact is the empty string.
` + '2. trigger_event is not "none" and gate is not null: write a HOOK. ' + hookShape(pattern) + ` Put it in "artifact" as an OBJECT.
` + "3. needs_own_context is true: write an AGENT, as a string. " + agentShape(pattern) + `
` + "4. capability_evidence is set: write a SKILL, as a string. " + skillShape(pattern) + `
` + "5. otherwise: write a RULE, as a string. " + ruleShape(pattern) + `

` + "The body MUST be in the shape the type you selected requires; a body " + "in the wrong shape is rejected and this lesson is dropped. Do not " + "restate this task, do not add commentary, do not leave angle-bracket " + `fill-ins, do not include secrets or tokens.

` + `Lessons to generalise:

` + sources + tail;
  }
  return [
    { role: "system", content: DRAFTER_SYSTEM },
    { role: "user", content: user }
  ];
}
function judgeMessages(pattern, artifactType, body, lessons) {
  const user = `Decide strictly but fairly whether this ${artifactType} may be ` + `committed for the recurring lesson '${pattern}'. Reject it if it ` + `violates any rule below; accept it if it violates none.

` + `Reject if ANY of these hold:
` + `1. CONTRADICTS: it advises the opposite of what a source concluded.
` + "2. VAGUE: it is generic advice ('be careful', 'verify things') that " + "would not change what someone does. Specific commands or checks must be " + `named.
` + `3. UNSUPPORTED: it instructs something no source supports.
` + "4. UNSAFE: it advises skipping a verification a source demands, or " + `acting on unverified claims to save time.
` + `5. UNRELATED: its topic is not the sources' topic.

` + "Method: quote the artifact's single most important instruction verbatim, " + "then name the source sentence that supports it, or state that none does. " + `Do not restate this question's wording as your reasoning.

` + 'Reply with one JSON object: {"verdict": "yes" or "no", ' + '"reason": one sentence holding that quote and its supporting source, ' + `or the rule number violated}.

` + `ARTIFACT:
${body}

SOURCES:
${boundedSources(lessons)}`;
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: user }
  ];
}
function loads(raw) {
  let cleaned = (raw ?? "").replace(THINK_RE, "").trim();
  const fenced = FENCE_RE.exec(cleaned);
  if (fenced)
    cleaned = fenced[1].trim();
  if (!cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start)
      return null;
    cleaned = cleaned.slice(start, end + 1);
  }
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return null;
  return data;
}
function parseDraft(raw, opts = {}) {
  const forcedType = opts.forcedType ?? null;
  const data = loads(raw);
  if (data === null) {
    const head = (raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 80);
    return [
      "",
      RouteAnswer.parse({
        parse_error: head ? `reply is not a JSON object (starts ${JSON.stringify(head)})` : "the provider returned an empty reply"
      })
    ];
  }
  const body = data["artifact"] ?? "";
  if (forcedType !== null)
    return [coerceBody(body, forcedType), emptyAnswer()];
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "artifact" || k === "parse_error")
      continue;
    fields[k] = v;
  }
  const parsed = RouteAnswer.safeParse(fields);
  if (!parsed.success) {
    return ["", RouteAnswer.parse({ parse_error: "routing fields failed validation: ZodError" })];
  }
  return [coerceBody(body, null), parsed.data];
}
function coerceBody(body, forcedType) {
  if (body !== null && typeof body === "object" && !Array.isArray(body))
    return body;
  let cleaned = String(body ?? "").replace(THINK_RE, "").trim();
  const fenced = FENCE_RE.exec(cleaned);
  if (fenced)
    cleaned = fenced[1].trim();
  if (forcedType === "hook" || forcedType === null && cleaned.startsWith("{")) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed;
    } catch {
      return cleaned;
    }
  }
  return cleaned;
}
function parseVerdict(raw) {
  const data = loads(raw);
  if (data === null) {
    const head = (raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 150);
    return [false, head ? `no verdict: unparseable judge reply: ${head}` : "no verdict: empty judge reply"];
  }
  const verdict = String(data["verdict"] ?? "").trim().toLowerCase();
  const reason = String(data["reason"] ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 300);
  if (["yes", "true", "accept", "accepted"].includes(verdict))
    return [true, reason || "accepted"];
  if (["no", "false", "reject", "rejected"].includes(verdict))
    return [false, reason || "rejected"];
  return [false, `no verdict: judge replied ${JSON.stringify(verdict)}`];
}
// packages/curriculum/src/plan.ts
import { readdirSync as readdirSync7, statSync as statSync7 } from "fs";
import { join as join12 } from "path";

// packages/feedback/src/index.ts
var exports_src3 = {};
__export(exports_src3, {
  appendUsage: () => appendUsage,
  listHuman: () => listHuman,
  load: () => load,
  rebuild: () => rebuild,
  recordHuman: () => recordHuman,
  scorecards: () => scorecards
});

// packages/store/src/reflections.ts
import { lstatSync, readdirSync as readdirSync3, realpathSync as realpathSync2, statSync as statSync5 } from "fs";
import { basename, join as join8, relative as relative2 } from "path";

// packages/store/src/aliases.ts
function loadAliases(world) {
  const raw = readJsonOr(aliasesFile(world), {});
  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = String(k);
    const val = String(v);
    if (isSlug(key) && isSlug(val))
      out[key] = val;
  }
  return out;
}
function saveAliases(world, aliases) {
  const values = new Set(Object.values(aliases));
  for (const key of Object.keys(aliases)) {
    if (!values.has(key))
      continue;
    const source = Object.entries(aliases).find(([k, v]) => v === key && k !== key)?.[0];
    throw new ValidationError(source ? `"${key}" is a key (-> "${aliases[key]}") and also the value of "${source}" (-> "${key}"); aliases resolve one hop only` : `"${key}" is a key (-> "${aliases[key]}") and also its own value`);
  }
  const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a < b ? -1 : 1));
  const p = aliasesFile(world);
  writeJson(p, sorted);
  return p;
}

// packages/store/src/reflections.ts
var PATTERN_RE = /^Pattern:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m;
function reflectionPattern(text) {
  const m = PATTERN_RE.exec(text);
  return m ? m[1] : null;
}
function splitFrontMatter(text) {
  if (text.startsWith(`---
`)) {
    const end = text.indexOf(`
---
`, 4);
    if (end !== -1) {
      let meta = {};
      try {
        meta = exports_dist.parse(text.slice(4, end)) ?? {};
      } catch {
        meta = {};
      }
      const obj = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
      return [obj, text.slice(end + 5)];
    }
  }
  return [{}, text];
}
function section(body, heading) {
  const idx = body.indexOf(heading);
  if (idx === -1)
    return "";
  const rest = body.slice(idx + heading.length);
  const nxt = rest.indexOf(`
## `);
  return (nxt === -1 ? rest : rest.slice(0, nxt)).trim();
}
var strList = (v) => Array.isArray(v) ? v.map(String) : [];
var strOrNull = (v) => v === undefined || v === null ? null : String(v);
function parseReflection(path, world) {
  let text;
  try {
    text = readText(path);
  } catch {
    return null;
  }
  const [meta, body] = splitFrontMatter(text);
  const pattern = reflectionPattern(body) ?? reflectionPattern(text);
  if (!pattern)
    return null;
  const created = meta["created"] ? String(meta["created"]) : new Date(statSync5(path).mtimeMs).toISOString().slice(0, 10);
  const parsed = Reflection.safeParse({
    id: meta["id"] ? String(meta["id"]) : basename(path).replace(/\.md$/, ""),
    world: meta["world"] ? String(meta["world"]) : world,
    pattern,
    path,
    created,
    session_id: strOrNull(meta["session_id"]),
    cwd: strOrNull(meta["cwd"]),
    revision: strOrNull(meta["revision"]),
    model: strOrNull(meta["model"]),
    artifacts_used: strList(meta["artifacts_used"]),
    artifacts_helpful: strList(meta["artifacts_helpful"]),
    artifacts_misfired: strList(meta["artifacts_misfired"]),
    lesson: section(body, "## Reusable lesson"),
    body
  });
  return parsed.success ? parsed.data : null;
}
function* walkMarkdown(dir, seen) {
  let entries;
  try {
    entries = readdirSync3(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "graphify-out" || name === "vec-index")
      continue;
    const p = join8(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkMarkdown(p, seen);
      continue;
    }
    if (!name.endsWith(".md"))
      continue;
    let real;
    try {
      real = realpathSync2(p);
    } catch {
      continue;
    }
    if (seen.has(real))
      continue;
    seen.add(real);
    yield p;
  }
}
function listReflections(world, extraDirs = []) {
  const out = [];
  const seen = new Set;
  for (const d of [reflectionsDir(world), ...extraDirs]) {
    for (const p of walkMarkdown(d, seen)) {
      if (relative2(d, p).startsWith(".."))
        continue;
      const r = parseReflection(p, world);
      if (r && r.world === world)
        out.push(r);
    }
  }
  out.sort((a, b) => a.created === b.created ? a.id < b.id ? 1 : -1 : a.created < b.created ? 1 : -1);
  return out;
}
function newReflectionId(pattern, when = new Date) {
  const d = when.toISOString().slice(0, 10);
  const rand = Math.floor(Math.random() * 65535).toString(16).padStart(4, "0");
  return `${d}-${pattern}-${rand}`;
}
function writeReflection(world, meta, body) {
  const pattern = reflectionPattern(body);
  if (!pattern)
    throw new Error("reflection body has no `Pattern: <slug>` line");
  const id = meta["id"] ? String(meta["id"]) : newReflectionId(pattern);
  const full = {
    id,
    world,
    pattern,
    created: meta["created"] ? String(meta["created"]) : today(),
    ...meta
  };
  const path = join8(reflectionsDir(world), `${id}.md`);
  if (exists(path))
    throw new Error(`reflection already exists: ${path}`);
  const front = exports_dist.stringify(full).trimEnd();
  atomicWrite(path, `---
${front}
---
${body.trimEnd()}
`);
  return path;
}
function patternCounts(world, extraDirs = []) {
  const counts = {};
  const aliases = loadAliases(world);
  for (const r of listReflections(world, extraDirs)) {
    const p = aliases[r.pattern] ?? r.pattern;
    counts[p] = (counts[p] ?? 0) + 1;
  }
  return counts;
}
// packages/store/src/alias-suggest.ts
var tokens = (s) => new Set(s.split("-"));
function jaccard(a, b) {
  let shared = 0;
  for (const t of a)
    if (b.has(t))
      shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
function isProperSubset(a, b) {
  if (a.size < 2 || a.size >= b.size)
    return false;
  for (const t of a)
    if (!b.has(t))
      return false;
  return true;
}
function suggestAliases(world) {
  const counts = patternCounts(world);
  const slugs = Object.keys(counts).sort();
  const out = [];
  for (let i = 0;i < slugs.length; i++) {
    for (let j = i + 1;j < slugs.length; j++) {
      const a = slugs[i];
      const b = slugs[j];
      const setA = tokens(a);
      const setB = tokens(b);
      const score = jaccard(setA, setB);
      if (score < 0.5 && !isProperSubset(setA, setB) && !isProperSubset(setB, setA))
        continue;
      const canonical = counts[a] >= counts[b] ? a : b;
      const alias = canonical === a ? b : a;
      out.push({ alias, canonical, alias_count: counts[alias], canonical_count: counts[canonical], score });
    }
  }
  out.sort((x, y) => {
    if (y.score !== x.score)
      return y.score - x.score;
    if (x.canonical !== y.canonical)
      return x.canonical < y.canonical ? -1 : 1;
    return x.alias < y.alias ? -1 : 1;
  });
  return out;
}
// packages/store/src/ledger.ts
function loadLedger(path) {
  if (!exists(path))
    return Ledger.parse({});
  return parseLedger(readText(path), path);
}
function parseLedger(text, label = "<text>") {
  try {
    let raw = JSON.parse(text.trim() === "" ? "{}" : text);
    if (Array.isArray(raw)) {
      raw = { version: 1, entries: byPattern(raw) };
    } else if (raw && typeof raw === "object" && Array.isArray(raw.entries)) {
      raw = { ...raw, entries: byPattern(raw.entries) };
    } else if (raw && typeof raw === "object" && !("entries" in raw)) {
      const values = Object.values(raw);
      if (values.every((v) => v && typeof v === "object"))
        raw = { version: 1, entries: raw };
    }
    const parsed = Ledger.safeParse(raw);
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return parsed.data;
  } catch (e) {
    throw new Error(`unreadable ledger ${label}: ${e.message}`);
  }
}
function byPattern(rows) {
  const out = {};
  for (const row of rows) {
    const pattern = row && typeof row === "object" ? row.pattern : undefined;
    out[typeof pattern === "string" ? pattern : ""] = row;
  }
  return out;
}
function saveLedger(path, ledger) {
  const entries = {};
  for (const key of Object.keys(ledger.entries).sort())
    entries[key] = stripNulls(ledger.entries[key]);
  atomicWrite(path, JSON.stringify({ version: ledger.version, entries }, null, 2) + `
`);
  return path;
}
function stripNulls(v) {
  if (Array.isArray(v))
    return v.map(stripNulls);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) {
      if (val !== null && val !== undefined)
        out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
}
// packages/store/src/inbox.ts
import { readdirSync as readdirSync4 } from "fs";
import { join as join9 } from "path";
function putLesson(lesson) {
  const p = join9(inboxDir(lesson.world), `${safeComponent(lesson.id)}.json`);
  writeJson(p, Lesson.parse(lesson));
  return p;
}
function listLessons(world) {
  const dir = inboxDir(world);
  let names;
  try {
    names = readdirSync4(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const raw = readJsonOr(join9(dir, name), null);
    const parsed = Lesson.safeParse(raw);
    if (parsed.success)
      out.push(parsed.data);
  }
  out.sort((a, b) => a.created < b.created ? 1 : -1);
  return out;
}
// packages/store/src/queue.ts
import { readdirSync as readdirSync5, rmSync as rmSync3 } from "fs";
import { join as join10 } from "path";
function entryPath(bucket, sessionId) {
  return join10(queueDir(bucket), `${safeComponent(sessionId)}.json`);
}
function listQueue(bucket) {
  let names;
  try {
    names = readdirSync5(queueDir(bucket)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const parsed = QueueEntry.safeParse(readJsonOr(join10(queueDir(bucket), name), null));
    if (parsed.success)
      out.push(parsed.data);
  }
  return out;
}
function loadEntry(bucket, sessionId) {
  const parsed = QueueEntry.safeParse(readJsonOr(entryPath(bucket, sessionId), null));
  return parsed.success ? parsed.data : null;
}
function writeEntry(bucket, entry) {
  const p = entryPath(bucket, entry.session_id);
  writeJson(p, QueueEntry.parse(entry));
  return p;
}
function moveEntry(entry, from, to, result = null) {
  const next = { ...entry, result: result ?? entry.result };
  const dest = writeEntry(to, next);
  rmSync3(entryPath(from, entry.session_id), { force: true });
  return dest;
}
// packages/critic/src/index.ts
import { readdirSync as readdirSync6, statSync as statSync6 } from "fs";
import { join as join11 } from "path";

// packages/providers/src/index.ts
var exports_src2 = {};
__export(exports_src2, {
  chat: () => chat,
  spawnSyncImpl: () => spawnSyncImpl,
  status: () => status
});
var spawnSyncImpl = {
  run: (cmd, opts) => Bun.spawnSync(cmd, { ...opts, stdout: "pipe", stderr: "pipe" })
};
var chat = async (role, messages, opts) => {
  const llm = opts.llm ?? loadLlm(opts.world);
  const { endpoint, model } = resolveRole(llm, role, opts.world);
  if (endpoint.kind === "openai")
    return chatOpenai(endpoint, model, messages, { jsonMode: opts.jsonMode ?? false, maxTokens: opts.maxTokens ?? 4000 });
  if (endpoint.kind === "claude-cli")
    return chatClaudeCli(endpoint, model, messages, { maxTokens: opts.maxTokens ?? 4000 });
  throw new ProviderError(`endpoint ${JSON.stringify(endpoint.name)} has unknown kind ${JSON.stringify(endpoint.kind)}`);
};
async function status(world, llm) {
  const result = { endpoint: null, kind: null, base_url: null, models: {}, reachable: null, error: null, endpoints: [] };
  let llmCfg;
  try {
    llmCfg = llm ?? loadLlm(world);
  } catch (e) {
    result.error = e.message;
    return result;
  }
  const servedBy = new Map;
  for (const role of ROLES) {
    try {
      servedBy.set(role, endpointFor(llmCfg, role).name);
    } catch {}
    try {
      result.models[role] = resolveRole(llmCfg, role, world).model;
    } catch {
      result.models[role] = null;
    }
  }
  let activeName = null;
  try {
    activeName = activeEndpoint(llmCfg).name;
  } catch {}
  result.endpoints = await Promise.all(llmCfg.endpoints.map(async (ep) => {
    const probe = await probeEndpoint(ep);
    return {
      name: ep.name,
      kind: ep.kind,
      base_url: ep.base_url,
      active: ep.name === activeName,
      roles: ROLES.filter((r) => servedBy.get(r) === ep.name),
      models: { ...ep.models },
      reachable: probe.reachable,
      error: probe.error
    };
  }));
  const criticEndpoint = result.endpoints.find((e) => e.name === servedBy.get("critic")) ?? null;
  if (criticEndpoint) {
    result.endpoint = criticEndpoint.name;
    result.kind = criticEndpoint.kind;
    result.base_url = criticEndpoint.base_url;
    result.reachable = criticEndpoint.reachable;
    result.error = criticEndpoint.error;
  } else {
    try {
      endpointFor(llmCfg, "critic");
    } catch (e) {
      result.error = e.message;
    }
  }
  return result;
}
async function probeEndpoint(endpoint) {
  if (endpoint.kind === "claude-cli")
    return probeClaudeCli();
  if (endpoint.kind !== "openai")
    return { reachable: null, error: `unknown endpoint kind ${JSON.stringify(endpoint.kind)}` };
  const base = (endpoint.base_url ?? "").replace(/\/+$/, "");
  if (!base)
    return { reachable: false, error: "no base_url configured" };
  let key;
  try {
    key = apiKey(endpoint);
  } catch (e) {
    return { reachable: false, error: e.message };
  }
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const url = v1Url(base) + "/models";
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    if (!resp.ok)
      return { reachable: false, error: `HTTP ${resp.status}` };
    return { reachable: true, error: null };
  } catch (e) {
    const err = e;
    return { reachable: false, error: `${err.name}: ${err.message}` };
  }
}
function probeClaudeCli() {
  try {
    const r = spawnSyncImpl.run(["claude", "--version"], { timeout: 5000 });
    if (r.exitedDueToTimeout)
      return { reachable: false, error: "claude --version timed out after 5s" };
    if (!r.success)
      return { reachable: false, error: `claude --version exited ${r.exitCode}: ${r.stderr.toString("utf8").slice(0, 200)}` };
    return { reachable: true, error: null };
  } catch (e) {
    return { reachable: false, error: `could not run claude --version: ${e.message}` };
  }
}
function v1Url(base) {
  return base.endsWith("/v1") ? base : base + "/v1";
}
async function chatOpenai(endpoint, model, messages, opts) {
  const base = (endpoint.base_url ?? "").replace(/\/+$/, "");
  if (!base)
    throw new ProviderError(`endpoint ${JSON.stringify(endpoint.name)} has no base_url configured`);
  const url = v1Url(base) + "/chat/completions";
  const body = { model, messages, temperature: 0, max_tokens: opts.maxTokens };
  if (opts.jsonMode)
    body["response_format"] = { type: "json_object" };
  Object.assign(body, endpoint.extra_body ?? {});
  const headers = { "Content-Type": "application/json" };
  const key = apiKey(endpoint);
  if (key)
    headers["Authorization"] = `Bearer ${key}`;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(endpoint.timeout_s * 1000)
    });
  } catch (e) {
    const err = e;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ProviderTimeout(`provider ${JSON.stringify(endpoint.name)} at ${url} timed out after ${endpoint.timeout_s}s`);
    }
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} unreachable: ${err.message}`);
  }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} answered HTTP ${resp.status}: ${detail}`);
  }
  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} returned non-JSON (${raw.length} bytes): ${JSON.stringify(raw.slice(0, 300))}`);
  }
  const content = extractChoiceContent(data);
  if (content === null)
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} reply has no choices[0].message.content`);
  if (content.trim() === "") {
    const meta = choiceMeta(data);
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} model ${JSON.stringify(model)} returned empty content ` + `(finish_reason ${JSON.stringify(meta.finishReason)}, ${meta.reasoningTokens} reasoning tokens, ` + `${meta.completionTokens} completion tokens). Set extra_body on the endpoint in llm.yaml, ` + `for example { reasoning_effort: "low" } or { thinking: { type: "disabled" } }, or raise max_tokens there.`);
  }
  return content;
}
function choiceMeta(data) {
  const d = data ?? {};
  const fr = d.choices?.[0]?.finish_reason;
  const num = (v) => typeof v === "number" ? v : 0;
  return {
    finishReason: typeof fr === "string" ? fr : null,
    reasoningTokens: num(d.usage?.completion_tokens_details?.reasoning_tokens),
    completionTokens: num(d.usage?.completion_tokens)
  };
}
function extractChoiceContent(data) {
  if (!data || typeof data !== "object")
    return null;
  const choices = data["choices"];
  if (!Array.isArray(choices) || choices.length === 0)
    return null;
  const first = choices[0];
  if (!first || typeof first !== "object")
    return null;
  const message = first["message"];
  if (!message || typeof message !== "object")
    return null;
  const content = message["content"];
  return typeof content === "string" ? content : null;
}
async function chatClaudeCli(endpoint, model, messages, _opts) {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const userParts = messages.filter((m) => m.role !== "system").map((m) => m.content);
  const cmd = ["claude", "-p", "--model", model, "--output-format", "json"];
  if (systemParts.length > 0)
    cmd.push("--append-system-prompt", systemParts.join(`

`));
  let result;
  try {
    result = spawnSyncImpl.run(cmd, { stdin: Buffer.from(userParts.join(`

`), "utf8"), timeout: endpoint.timeout_s * 1000 });
  } catch (e) {
    throw new ProviderError(`failed to run claude -p: ${e.message}`);
  }
  if (result.exitedDueToTimeout) {
    throw new ProviderTimeout(`claude -p timed out after ${endpoint.timeout_s}s`);
  }
  if (!result.success) {
    const stderrText = result.stderr.toString("utf8");
    const stdoutText = result.stdout.toString("utf8");
    throw new ProviderError(`claude -p exited ${result.exitCode}: ${(stderrText || stdoutText).slice(0, 300)}`);
  }
  const stdoutText = result.stdout.toString("utf8");
  let data;
  try {
    data = JSON.parse(stdoutText);
  } catch {
    throw new ProviderError(`claude -p returned non-JSON output: ${JSON.stringify(stdoutText.slice(0, 300))}`);
  }
  const obj = data && typeof data === "object" ? data : null;
  const resultField = obj ? obj["result"] : undefined;
  if (resultField === undefined || resultField === null) {
    throw new ProviderError(`claude -p reply has no 'result' field: ${JSON.stringify(String(data).slice(0, 300))}`);
  }
  return String(resultField);
}

// packages/transcript/src/index.ts
import { existsSync as existsSync6, readFileSync as readFileSync3 } from "fs";
var NOISE_TYPES = new Set(["ai-title", "last-prompt", "queue-operation", "atis-latch"]);
var TEST_LIKE_RE = /pytest|jest|vitest|go test|cargo test|npm test|pnpm test|make test|ruff|eslint|tsc|mypy/;
var SUMMARY_KEYS = ["command", "file_path", "skill", "subagent_type", "pattern", "path"];
function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function asArray(v) {
  return Array.isArray(v) ? v : [];
}
function* iterRecords(path, maxBytes = 50000000) {
  if (!existsSync6(path))
    return;
  let text;
  try {
    text = readFileSync3(path, "utf8");
  } catch {
    return;
  }
  let readBytes = 0;
  for (const rawLine of text.split(`
`)) {
    readBytes += Buffer.byteLength(rawLine, "utf8") + 1;
    if (readBytes > maxBytes)
      break;
    const line = rawLine.trim();
    if (!line)
      continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = asRecord(rec);
    if (obj)
      yield obj;
  }
}
function countToolUses(path) {
  let count = 0;
  for (const rec of iterRecords(path)) {
    if (rec["type"] !== "assistant")
      continue;
    for (const block of contentBlocks(rec)) {
      const b = asRecord(block);
      if (b && b["type"] === "tool_use")
        count++;
    }
  }
  return count;
}
function contentBlocks(rec) {
  const message = asRecord(rec["message"]) ?? {};
  return asArray(message["content"]);
}
function recordText(rec) {
  const message = asRecord(rec["message"]) ?? {};
  const content = message["content"];
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const parts = content.map((b) => asRecord(b)).filter((b) => b !== null && b["type"] === "text").map((b) => String(b["text"] ?? ""));
    return parts.join(`
`);
  }
  return "";
}
function stringifyToolResultContent(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      const obj = asRecord(b);
      if (obj && obj["type"] === "text")
        parts.push(String(obj["text"] ?? ""));
      else if (typeof b === "string")
        parts.push(b);
    }
    return parts.join(`
`);
  }
  if (content === null || content === undefined)
    return "";
  return String(content);
}
function toolSummary(inp) {
  for (const key of SUMMARY_KEYS) {
    const val = inp[key];
    if (val)
      return String(val);
  }
  return Object.keys(inp).length > 0 ? JSON.stringify(inp).slice(0, 160) : "";
}
function recordHook(rec, hooks) {
  const att = asRecord(rec["attachment"]);
  if (!att || !att["hookName"])
    return;
  const name = String(att["hookName"]);
  const h = hooks[name] ??= { runs: 0, errors: 0, max_ms: 0 };
  h.runs += 1;
  if (String(att["exitCode"] ?? "0") !== "0")
    h.errors += 1;
  const ms = Number.parseInt(String(att["durationMs"] ?? "0"), 10);
  h.max_ms = Math.max(h.max_ms, Number.isFinite(ms) ? ms : 0);
}
function recordUser(rec, prompts, counts, toolResultById, errors) {
  const message = asRecord(rec["message"]) ?? {};
  const content = message["content"];
  const blocks = asArray(content);
  const hasText = typeof content === "string" || blocks.some((b) => {
    const obj = asRecord(b);
    return obj !== null && obj["type"] === "text";
  });
  for (const b of blocks) {
    const obj = asRecord(b);
    if (!obj || obj["type"] !== "tool_result")
      continue;
    const toolUseId = obj["tool_use_id"];
    const isError = Boolean(obj["is_error"]);
    const contentText = stringifyToolResultContent(obj["content"]);
    if (toolUseId)
      toolResultById.set(String(toolUseId), { is_error: isError, content: contentText });
    if (isError)
      errors.push(contentText.slice(0, 300));
  }
  if (hasText) {
    const text = recordText(rec).trim();
    if (text && !text.startsWith("<")) {
      counts.user_prompts += 1;
      prompts.push(text.slice(0, 400));
    }
  }
}
function evidencePack(transcriptPath, cwd, opts = {}) {
  const maxChars = opts.maxChars ?? 24000;
  const gitHeadAtStart = opts.gitHeadAtStart ?? null;
  let sessionId = null;
  const prompts = [];
  const finalAssistantTexts = [];
  const toolUseEntries = [];
  const toolResultById = new Map;
  const skillsUsed = [];
  const agentsUsed = [];
  const hooks = {};
  const errors = [];
  const counts = { tool_uses: 0, turns: 0, user_prompts: 0, attachments: 0 };
  for (const rec of iterRecords(transcriptPath)) {
    const rtype = rec["type"];
    if (typeof rtype === "string" && NOISE_TYPES.has(rtype))
      continue;
    if (sessionId === null && rec["sessionId"])
      sessionId = String(rec["sessionId"]);
    if (rtype === "attachment") {
      counts.attachments += 1;
      recordHook(rec, hooks);
      continue;
    }
    if (rtype === "user") {
      recordUser(rec, prompts, counts, toolResultById, errors);
      continue;
    }
    if (rtype === "assistant") {
      counts.turns += 1;
      const text = recordText(rec);
      if (text && text.trim())
        finalAssistantTexts.push(text.trim().slice(0, 800));
      for (const block of contentBlocks(rec)) {
        const b = asRecord(block);
        if (!b || b["type"] !== "tool_use")
          continue;
        counts.tool_uses += 1;
        const name = String(b["name"] ?? "");
        const inp = asRecord(b["input"]) ?? {};
        const summary = toolSummary(inp);
        toolUseEntries.push({ id: b["id"] != null ? String(b["id"]) : null, name, summary: summary.slice(0, 160) });
        if (name === "Skill" && inp["skill"])
          skillsUsed.push(String(inp["skill"]));
        else if (name === "Agent") {
          agentsUsed.push({
            subagent_type: inp["subagent_type"] != null ? String(inp["subagent_type"]) : "",
            model: inp["model"] != null ? String(inp["model"]) : null
          });
        }
      }
      continue;
    }
  }
  const toolCallsFull = [];
  const bashFull = [];
  for (const t of toolUseEntries) {
    const res = (t.id !== null ? toolResultById.get(t.id) : undefined) ?? { is_error: false, content: "" };
    toolCallsFull.push({ name: t.name, summary: t.summary, is_error: res.is_error });
    if (t.name === "Bash") {
      const tail = res.content.slice(-300);
      bashFull.push({ command: t.summary, is_error: res.is_error, tail });
    }
  }
  const toolCalls = toolCallsFull.length > 80 ? [...toolCallsFull.slice(0, 20), ...toolCallsFull.slice(-60)] : toolCallsFull;
  const bash = bashFull.slice(-30);
  const testLike = bash.filter((b) => TEST_LIKE_RE.test(b.command || ""));
  const pack = {
    session_id: sessionId ?? "",
    cwd: String(cwd),
    prompts: prompts.slice(0, 12),
    final_assistant_texts: finalAssistantTexts.slice(-3),
    tool_calls: toolCalls,
    bash,
    test_like: testLike,
    skills_used: skillsUsed,
    agents_used: agentsUsed,
    hooks,
    errors: errors.slice(0, 15),
    counts,
    git: gitInfo(cwd, gitHeadAtStart)
  };
  return enforceBudget(pack, maxChars);
}
function git2(cwd, args, timeoutMs = 5000) {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd, timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
    return r.success ? r.stdout.toString("utf8") : null;
  } catch {
    return null;
  }
}
function gitInfo(cwd, headAtStart) {
  const info = {
    head_at_start: headAtStart,
    head_now: null,
    diff_stat: "",
    diff_excerpt: "",
    files_changed: []
  };
  if (git2(cwd, ["rev-parse", "--show-toplevel"]) === null)
    return info;
  const headNow = git2(cwd, ["rev-parse", "HEAD"]);
  info.head_now = headNow ? headNow.trim() : null;
  const diffs = [];
  const stats = [];
  const names = new Set;
  if (headAtStart) {
    diffs.push(git2(cwd, ["diff", `${headAtStart}..HEAD`]) ?? "");
    stats.push(git2(cwd, ["diff", "--stat", `${headAtStart}..HEAD`]) ?? "");
    for (const line of (git2(cwd, ["diff", "--name-only", `${headAtStart}..HEAD`]) ?? "").split(`
`)) {
      if (line.trim())
        names.add(line.trim());
    }
  }
  diffs.push(git2(cwd, ["diff"]) ?? "");
  stats.push(git2(cwd, ["diff", "--stat"]) ?? "");
  for (const line of (git2(cwd, ["diff", "--name-only"]) ?? "").split(`
`)) {
    if (line.trim())
      names.add(line.trim());
  }
  info.diff_excerpt = diffs.filter((d) => d).join(`
`).slice(0, 6000);
  info.diff_stat = stats.filter((s) => s).join(`
`).trim();
  info.files_changed = [...names].sort();
  return info;
}
function enforceBudget(pack, maxChars) {
  const size = () => JSON.stringify(pack).length;
  if (size() <= maxChars)
    return pack;
  let excerpt = pack.git.diff_excerpt;
  while (excerpt && size() > maxChars) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
    pack.git.diff_excerpt = excerpt;
  }
  while (pack.tool_calls.length > 20 && size() > maxChars) {
    pack.tool_calls.splice(20, 1);
  }
  while (size() > maxChars && pack.bash.length > 0) {
    const longest = pack.bash.reduce((a, b) => b.tail.length > a.tail.length ? b : a);
    if (longest.tail.length <= 20)
      break;
    longest.tail = longest.tail.slice(0, Math.floor(longest.tail.length / 2));
  }
  return pack;
}

// packages/critic/src/index.ts
var CLOSED_PATTERNS = new Set(["evidence-level-overclaim"]);
function installedArtifacts(world, _cfg) {
  const refs = new Set;
  try {
    const ledger = loadLedger(ledgerPath(world));
    for (const entry of Object.values(ledger.entries)) {
      if (entry.status === "promoted")
        refs.add(`${entry.artifact_type}:${entry.pattern}`);
    }
  } catch {}
  let root;
  try {
    root = targetRoot(world);
  } catch {
    return [...refs].sort();
  }
  const skillsDir = join11(root, world.layout.skills_dir);
  for (const name of listDir(skillsDir)) {
    if (isDir(join11(skillsDir, name)))
      refs.add(`skill:${name}`);
  }
  const nudgesDir = join11(root, world.layout.nudges_dir);
  for (const name of listDir(nudgesDir)) {
    if (name.endsWith(".json"))
      refs.add(`hook:${nudgePattern(join11(nudgesDir, name))}`);
  }
  const agentsDir = join11(root, world.layout.agents_dir);
  for (const name of listDir(agentsDir)) {
    if (name.endsWith(".md"))
      refs.add(`agent:${name.replace(/\.md$/, "")}`);
  }
  const rulesFile = join11(root, world.layout.rules_file);
  if (exists(rulesFile)) {
    const text = readTextOr(rulesFile, "");
    for (const m of text.matchAll(/<!--rule:([a-z0-9-]+)-->/g))
      refs.add(`rule:${m[1]}`);
  }
  return [...refs].sort();
}
function listDir(dir) {
  try {
    return readdirSync6(dir);
  } catch {
    return [];
  }
}
function isDir(p) {
  try {
    return statSync6(p).isDirectory();
  } catch {
    return false;
  }
}
function nudgePattern(p) {
  const stem = p.split("/").pop().replace(/\.json$/, "");
  const raw = readJsonOr(p, null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const pattern = raw["pattern"];
    if (pattern)
      return String(pattern);
  }
  return stem;
}
function buildMessages(pack, opts) {
  const closed = [...CLOSED_PATTERNS].sort();
  const system = "You are a reporter, not a fixer. Audit the claims in this evidence pack " + "against the recorded tool calls and their results, not the assistant's " + "prose alone. Output STRICT JSON only, no prose, no code fence, with " + "exactly these keys: record (bool), pattern (kebab-case slug or null), " + "what_worked (string), what_failed (string), lesson (string, one " + "concrete imperative rule, <= 300 chars), verification (string: what " + "the evidence shows, commands and exit codes), not_verified (list of " + "strings), lesson_short (string <= 200 chars for a future session, or " + "null), confidence (number 0..1), artifacts_used (list of strings), " + "artifacts_helpful (list of strings), artifacts_misfired (list of " + '{"ref": string, "reason": string}), rules_relevant (list of strings). ' + "artifacts_used/artifacts_helpful/artifacts_misfired/rules_relevant " + "must only reference refs from the installed artifacts list, or ones " + "derivable from the pack's skills_used/agents_used/hooks fields. Set " + "record false and pattern null when there is no concrete reusable " + `lesson.

` + `The slug(s) ${JSON.stringify(closed)} are CLOSED: reuse one only when ` + "the mechanism matches exactly, never coin a sibling like overclaimed-*, " + "unverified-* or insufficient-evidence-*. Name the mechanism (e.g. " + "stale-cached-env, relayed-subagent-claim, absence-from-filtered-view), " + "never the evidence grade. Reuse an existing pattern slug below when its " + "mechanism matches this occurrence rather than coining a near-duplicate.";
  const existingDesc = Object.entries(opts.existingPatterns).sort(([a], [b]) => a < b ? -1 : 1).map(([p, n]) => `${p} (${n})`).join(", ") || "none yet";
  const user = {
    world: opts.world.name,
    existing_patterns: opts.existingPatterns,
    installed_artifacts: opts.installedArtifacts,
    recent_reflection_ids: opts.recentTitles,
    evidence: pack
  };
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `Existing pattern slugs and occurrence counts for world ` + `${JSON.stringify(opts.world.name)}: ${existingDesc}. Reuse one when the mechanism ` + `matches this occurrence.

Evidence pack (JSON):
` + JSON.stringify(user)
    }
  ];
}
var FENCE_RE2 = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;
function parseAnswer(text) {
  let cleaned = (text ?? "").trim();
  const fence = FENCE_RE2.exec(cleaned);
  if (fence)
    cleaned = fence[1].trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start)
    return rejected("no JSON object found in critic reply");
  let data;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return rejected(`unparseable critic reply: ${e.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return rejected("critic reply JSON is not an object");
  return validated(data);
}
function rejected(reason) {
  return {
    record: false,
    pattern: null,
    what_worked: "",
    what_failed: "",
    lesson: "",
    verification: "",
    not_verified: [reason],
    lesson_short: null,
    confidence: 0,
    artifacts_used: [],
    artifacts_helpful: [],
    artifacts_misfired: [],
    rules_relevant: [],
    reason
  };
}
function validated(data) {
  const record = Boolean(data["record"]);
  let pattern = data["pattern"] != null ? String(data["pattern"]) : null;
  if (pattern !== null)
    pattern = pattern.trim().toLowerCase().replace(/ /g, "-").replace(/-+/g, "-");
  if (record && (!pattern || !isSlug(pattern)))
    return rejected(`record is true but pattern ${JSON.stringify(pattern)} is not a valid slug`);
  let confidence = 0;
  const rawConfidence = data["confidence"];
  const num = typeof rawConfidence === "number" ? rawConfidence : typeof rawConfidence === "string" ? Number(rawConfidence) : NaN;
  if (Number.isFinite(num))
    confidence = Math.max(0, Math.min(1, num));
  const lessonShort = data["lesson_short"];
  return {
    record,
    pattern: record ? pattern : null,
    what_worked: strOr(data["what_worked"]),
    what_failed: strOr(data["what_failed"]),
    lesson: strOr(data["lesson"]).slice(0, 300),
    verification: strOr(data["verification"]),
    not_verified: strList2(data["not_verified"]),
    lesson_short: lessonShort ? String(lessonShort).slice(0, 200) : null,
    confidence,
    artifacts_used: strList2(data["artifacts_used"]),
    artifacts_helpful: strList2(data["artifacts_helpful"]),
    artifacts_misfired: misfiredList(data["artifacts_misfired"]),
    rules_relevant: strList2(data["rules_relevant"])
  };
}
function strOr(v) {
  return v ? String(v) : "";
}
function strList2(v) {
  return Array.isArray(v) ? v.map(String) : [];
}
function misfiredList(v) {
  if (!Array.isArray(v))
    return [];
  const out = [];
  for (const item of v) {
    if (item && typeof item === "object" && !Array.isArray(item) && item["ref"]) {
      const obj = item;
      out.push({ ref: String(obj["ref"]), reason: obj["reason"] ? String(obj["reason"]) : "" });
    } else if (typeof item === "string" && item) {
      out.push({ ref: item, reason: "" });
    }
  }
  return out;
}
async function reflectSession(entry, opts) {
  const chatFn = opts.chat ?? chat;
  const llmCfg = opts.llm ?? loadLlm(opts.world);
  const model = modelFor(llmCfg, "critic", opts.world);
  const pack = evidencePack(entry.transcript_path, entry.cwd, { gitHeadAtStart: entry.git_head });
  const existingPatterns = patternCounts(opts.world.name);
  const recentTitles = listReflections(opts.world.name).slice(0, 25).map((r) => r.id);
  const artifacts = installedArtifacts(opts.world, opts.cfg);
  const messages = buildMessages(pack, {
    world: opts.world,
    existingPatterns,
    installedArtifacts: artifacts,
    recentTitles
  });
  const raw = await chatFn("critic", messages, { world: opts.world, llm: llmCfg, jsonMode: true });
  const answer = parseAnswer(raw);
  if (!answer.record || !answer.pattern) {
    return {
      recorded: false,
      reflection_id: null,
      pattern: null,
      path: null,
      reason: answer.reason || "not-recorded: no reusable lesson found"
    };
  }
  const pattern = answer.pattern;
  const body = renderBody(pattern, answer);
  const headNow = pack.git.head_now;
  const revision = entry.git_head && headNow ? `${entry.git_head}..${headNow}` : null;
  const meta = {
    session_id: entry.session_id,
    cwd: entry.cwd,
    revision,
    model,
    artifacts_used: answer.artifacts_used,
    artifacts_helpful: answer.artifacts_helpful,
    artifacts_misfired: answer.artifacts_misfired.map((m) => m.ref),
    confidence: answer.confidence
  };
  const path = writeReflection(opts.world.name, meta, body);
  const reflectionId = path.split("/").pop().replace(/\.md$/, "");
  const ts = nowIso();
  appendFeedbackEvents(opts.world.name, reflectionId, answer, ts);
  if (answer.lesson_short && answer.confidence >= 0.5) {
    putLesson({
      id: reflectionId,
      world: opts.world.name,
      pattern,
      text: answer.lesson_short,
      created: ts,
      reflection_id: reflectionId,
      repo: gitToplevel(entry.cwd),
      deliveries: 0
    });
  }
  return { recorded: true, reflection_id: reflectionId, pattern, path, reason: "" };
}
function renderBody(pattern, answer) {
  const today2 = today();
  const notVerifiedText = answer.not_verified.length > 0 ? answer.not_verified.map((x) => `- ${x}`).join(`
`) : "none, checked scope: transcript evidence pack and repo diff";
  const [worked, failed, lesson, verification, notVerified] = SECTIONS;
  return `Last updated: ${today2}

` + `Pattern: ${pattern}

` + `${worked}
` + `${answer.what_worked || "n/a"}
` + `${failed}
` + `${answer.what_failed || "n/a"}
` + `${lesson}
` + `${answer.lesson || "n/a"}
` + `${verification}
` + `${answer.verification || "n/a"}
` + `${notVerified}
` + `${notVerifiedText}
`;
}
function appendFeedbackEvents(world, reflectionId, answer, ts) {
  const lines = [];
  for (const ref of answer.artifacts_used)
    lines.push({ ref, verdict: "used", reflection_id: reflectionId, ts, world });
  for (const ref of answer.artifacts_helpful)
    lines.push({ ref, verdict: "helpful", reflection_id: reflectionId, ts, world });
  for (const m of answer.artifacts_misfired)
    lines.push({ ref: m.ref, verdict: "misfired", reflection_id: reflectionId, ts, world, reason: m.reason });
  for (const ref of answer.rules_relevant)
    lines.push({ ref: ref.includes(":") ? ref : `rule:${ref}`, verdict: "relevant", reflection_id: reflectionId, ts, world });
  if (lines.length === 0)
    return;
  const path = criticFeedbackFile();
  for (const line of lines)
    appendJsonl(path, line);
}
function gitToplevel(cwd) {
  const run = (args) => {
    try {
      const r = Bun.spawnSync(["git", ...args], { cwd, timeout: 5000, stdout: "pipe", stderr: "pipe" });
      if (!r.success)
        return null;
      const out = r.stdout.toString("utf8").trim();
      return out || null;
    } catch {
      return null;
    }
  };
  const common = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common && common.endsWith("/.git"))
    return common.slice(0, -"/.git".length);
  return run(["rev-parse", "--show-toplevel"]);
}

// packages/feedback/src/index.ts
function appendUsage(event) {
  appendJsonl(usageEventsFile(), event);
}
function recordHuman(fb) {
  const path = humanFeedbackFile();
  appendJsonl(path, fb);
  return path;
}
function listHuman(world) {
  const all = readJsonl(humanFeedbackFile());
  return world === undefined ? all : all.filter((f) => f.world === world);
}
function scorecards(world, cfg, opts = {}) {
  const now = opts.now ?? new Date;
  const windowDays = opts.windowDays ?? 30;
  const windowStart = new Date(now.getTime() - windowDays * 86400000);
  const retireCutoff = new Date(now.getTime() - cfg.promotion.retire_after_days * 86400000);
  const ledger = loadLedgerSafe(world);
  const refs = new Set(installedArtifacts(world, cfg));
  const usesByRef = new Map;
  const firesByRef = new Map;
  const helpfulByRef = new Map;
  const misfiredByRef = new Map;
  const humanGoodByRef = new Map;
  const humanBadByRef = new Map;
  const lastTsByRef = new Map;
  const bump = (m, ref) => {
    m.set(ref, (m.get(ref) ?? 0) + 1);
  };
  const noteTs = (ref, ts) => {
    if (!ts)
      return;
    const str = String(ts);
    const cur = lastTsByRef.get(ref);
    if (cur === undefined || str > cur)
      lastTsByRef.set(ref, str);
  };
  for (const ev of readJsonl(usageEventsFile())) {
    if (ev["world"] !== world.name)
      continue;
    const kind = ev["kind"];
    if (kind !== "skill" && kind !== "agent" && kind !== "rule")
      continue;
    const ref = ev["ref"];
    if (!ref)
      continue;
    const r = String(ref);
    refs.add(r);
    noteTs(r, ev["ts"]);
    if (within(ev["ts"], windowStart, now))
      bump(usesByRef, r);
  }
  for (const line of readJsonl(nudgeFiresFile())) {
    const pattern = line["pattern"];
    if (!pattern)
      continue;
    const ref = `hook:${String(pattern)}`;
    refs.add(ref);
    noteTs(ref, line["ts"]);
    if (within(line["ts"], windowStart, now)) {
      bump(firesByRef, ref);
      bump(usesByRef, ref);
    }
  }
  for (const ev of readJsonl(criticFeedbackFile())) {
    if (ev["world"] !== world.name)
      continue;
    const ref = ev["ref"];
    if (!ref)
      continue;
    const r = String(ref);
    refs.add(r);
    noteTs(r, ev["ts"]);
    if (ev["verdict"] === "helpful")
      bump(helpfulByRef, r);
    else if (ev["verdict"] === "misfired")
      bump(misfiredByRef, r);
  }
  for (const ev of readJsonl(humanFeedbackFile())) {
    if (ev["world"] !== world.name)
      continue;
    const ref = ev["ref"];
    if (!ref)
      continue;
    const r = String(ref);
    refs.add(r);
    noteTs(r, ev["ts"]);
    if (ev["vote"] === "good")
      bump(humanGoodByRef, r);
    else if (ev["vote"] === "bad")
      bump(humanBadByRef, r);
  }
  const out = [];
  for (const ref of [...refs].sort()) {
    const sep = ref.indexOf(":");
    const atype = sep === -1 ? ref : ref.slice(0, sep);
    const name = sep === -1 ? "" : ref.slice(sep + 1);
    const uses = usesByRef.get(ref) ?? 0;
    const fires = firesByRef.get(ref) ?? 0;
    const helpful = helpfulByRef.get(ref) ?? 0;
    const misfired = misfiredByRef.get(ref) ?? 0;
    const humanGood = humanGoodByRef.get(ref) ?? 0;
    const humanBad = humanBadByRef.get(ref) ?? 0;
    const lastUsed = lastTsByRef.get(ref) ?? null;
    const entry = ledger.entries[name];
    const [proposal, reason] = propose(entry, uses, fires, helpful, misfired, humanGood, humanBad, lastUsed, now, retireCutoff, cfg.promotion.retire_after_days);
    out.push({
      ref,
      type: atype,
      name,
      uses_30d: uses,
      fires_30d: fires,
      helpful,
      misfired,
      human_good: humanGood,
      human_bad: humanBad,
      last_used: lastUsed,
      proposal,
      reason
    });
  }
  return out;
}
function propose(entry, uses, fires, helpful, misfired, humanGood, humanBad, lastUsed, now, retireCutoff, retireDays) {
  const promotedTs = entry === undefined ? null : entry.promoted_at ?? entry.last_updated;
  const promotedDt = parseTs(promotedTs);
  if (promotedDt !== null && promotedDt.getTime() >= now.getTime() - 7 * 86400000) {
    const days = Math.floor((now.getTime() - promotedDt.getTime()) / 86400000);
    return ["new", `promoted ${days}d ago, within the 7 day new window`];
  }
  if (entry !== undefined && entry.status === "promoted" && uses + fires === 0 && humanGood === 0) {
    const lastDt = parseTs(lastUsed);
    const basisDt = lastDt ?? promotedDt;
    const stale = basisDt === null || basisDt.getTime() < retireCutoff.getTime();
    if (stale) {
      const used = lastUsed === null ? "never used" : `last used ${lastUsed}, which is not a readable date`;
      const basis = lastDt !== null ? `last used ${lastUsed}, older than ${retireDays}d` : basisDt !== null ? `${used}, promoted ${promotedTs}, older than ${retireDays}d` : "no parsable date to judge staleness from";
      return ["retire-candidate", `no uses or fires in the last window, ${basis}`];
    }
  }
  if (misfired + humanBad >= 2 && misfired + humanBad > helpful + humanGood) {
    return ["refine", `misfired+human_bad=${misfired + humanBad} exceeds helpful+human_good=${helpful + humanGood}`];
  }
  return ["keep", "no signal strong enough to change"];
}
function rebuild(world, cfg) {
  const cards = scorecards(world, cfg);
  const path = scorecardsFile(world.name);
  writeJson(path, cards);
  return path;
}
function load(world) {
  const path = scorecardsFile(world.name);
  const raw = readJsonOr(path, null);
  if (!Array.isArray(raw))
    return [];
  const out = [];
  for (const item of raw) {
    const parsed = validateScorecard(item);
    if (parsed)
      out.push(parsed);
  }
  return out;
}
function validateScorecard(item) {
  if (!item || typeof item !== "object")
    return null;
  const o = item;
  if (typeof o["ref"] !== "string" || typeof o["type"] !== "string" || typeof o["name"] !== "string")
    return null;
  return {
    ref: o["ref"],
    type: o["type"],
    name: o["name"],
    uses_30d: Number(o["uses_30d"] ?? 0),
    fires_30d: Number(o["fires_30d"] ?? 0),
    helpful: Number(o["helpful"] ?? 0),
    misfired: Number(o["misfired"] ?? 0),
    human_good: Number(o["human_good"] ?? 0),
    human_bad: Number(o["human_bad"] ?? 0),
    last_used: o["last_used"] ? String(o["last_used"]) : null,
    proposal: o["proposal"] ?? "keep",
    reason: o["reason"] ? String(o["reason"]) : ""
  };
}
function loadLedgerSafe(world) {
  try {
    return loadLedger(ledgerPath(world));
  } catch {
    return { version: 1, entries: {} };
  }
}
function parseTs(ts) {
  if (!ts)
    return null;
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}
function within(ts, start, end) {
  const t = parseTs(ts);
  return t !== null && t.getTime() >= start.getTime() && t.getTime() <= end.getTime();
}

// packages/curriculum/src/plan.ts
function reflections2(world, extraDirs = []) {
  const aliases = loadAliases(world.name);
  return listReflections(world.name, extraDirs).map((r) => {
    const canonical = aliases[r.pattern] ?? r.pattern;
    return canonical === r.pattern ? r : { ...r, pattern: canonical };
  });
}
function cluster(items) {
  const groups = new Map;
  for (const item of items) {
    const bucket = groups.get(item.pattern);
    if (bucket)
      bucket.push(item);
    else
      groups.set(item.pattern, [item]);
  }
  const out = [];
  for (const pattern of [...groups.keys()].sort()) {
    const group = groups.get(pattern);
    group.sort((a, b) => a.created === b.created ? a.id < b.id ? -1 : 1 : a.created < b.created ? -1 : 1);
    out.push({ pattern, items: group });
  }
  return out;
}
function lessonTexts(items) {
  return items.map((r) => (r.lesson || r.body || "").trim());
}
function sourcesText(items) {
  return items.map((r) => r.body || "").join(`

`);
}
function loadLedger2(world) {
  return loadLedger(ledgerPath(world));
}
function loadPayloadCorpus(world) {
  const roots = [pluginRoot()];
  if (world)
    roots.push(targetRoot(world));
  const out = [];
  const seen = new Set;
  for (const root of roots) {
    const dir = join12(root, "tests", "fixtures", "hook-payloads");
    if (seen.has(dir))
      continue;
    try {
      if (!statSync7(dir).isDirectory())
        continue;
    } catch {
      continue;
    }
    seen.add(dir);
    for (const name of readdirSync7(dir).filter((n) => n.endsWith(".json")).sort()) {
      const path = join12(dir, name);
      let parsed;
      try {
        parsed = JSON.parse(readText(path));
      } catch (e) {
        throw new ValidationError(`unreadable hook payload ${path}: ${e.message}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ValidationError(`unreadable hook payload ${path}: not a JSON object`);
      }
      out.push(parsed);
    }
  }
  return out;
}
function scorecards2(world) {
  try {
    return [...load(world)];
  } catch {
    return [];
  }
}
function scorecardByPattern(cards) {
  const out = new Map;
  for (const card of cards) {
    const name = card.name || (card.ref ? card.ref.split(":").slice(-1)[0] : "");
    if (name && !out.has(name))
      out.set(name, card);
  }
  return out;
}
function watermark(ledger, pattern) {
  const entry = ledger.entries[pattern];
  if (!entry)
    return 0;
  return Math.max(entry.promoted_at_count, entry.rejected_at_count);
}
function plan(world, cfg, opts = {}) {
  const threshold = cfg.promotion.threshold;
  const cap = cfg.promotion.per_run_cap;
  const ledger = loadLedger2(world);
  const groups = cluster(opts.items ?? reflections2(world, opts.extraDirs ?? []));
  const byPattern = scorecardByPattern(opts.cards ?? scorecards2(world));
  const actions = [];
  for (const { pattern, items } of groups) {
    const count = items.length;
    const mark = watermark(ledger, pattern);
    const entry = ledger.entries[pattern];
    const card = byPattern.get(pattern);
    const sources = items.map((r) => r.id);
    let action = "below-threshold";
    let reason = "";
    if (count - mark >= threshold) {
      action = "promote";
      reason = `${count - mark} new reflection(s) past the watermark ${mark}`;
    } else if (entry && entry.status === "promoted" && card) {
      if (card.proposal === "refine") {
        action = "refine";
        reason = card.reason || "scorecard proposes a refine";
      } else if (card.proposal === "retire-candidate") {
        action = "retire-candidate";
        reason = card.reason || "scorecard proposes retirement";
      } else {
        action = "done";
        reason = `watermark ${mark}, ${count} reflection(s)`;
      }
    } else if (entry) {
      action = "done";
      reason = `watermark ${mark}, ${count} reflection(s)`;
    } else {
      reason = `${count} reflection(s); the threshold is ${threshold}`;
    }
    actions.push({ pattern, count, watermark: mark, action, sources, reason });
  }
  if (opts.enforceCap ?? true) {
    let budget = cap;
    for (const item of actions) {
      if (item.action === "promote" || item.action === "refine") {
        if (budget > 0)
          budget -= 1;
        else {
          item.action = "over-cap";
          item.reason = `over the per-run cap of ${cap}`;
        }
      }
    }
  }
  return { world: world.name, threshold, actions };
}
// packages/curriculum/src/run.ts
import { existsSync as existsSync7 } from "fs";
import { join as join13, resolve as resolve4 } from "path";
function branchName(world, pattern) {
  return `curriculum/${world.toLowerCase()}/${pattern}`;
}
function describe2(e) {
  const err = e;
  return `${err?.name || "Error"}: ${String(err?.message ?? e).slice(0, 160)}`;
}
function draftedType(answer) {
  if (answer.trigger_event !== "none" && answer.gate !== null)
    return "hook";
  if (answer.needs_own_context)
    return "agent";
  if (answer.capability_evidence !== null)
    return "skill";
  return "rule";
}
function branchEntry(world, repo, branch, pattern) {
  if (!refExists(repo, `refs/heads/${branch}`))
    return null;
  const { found, text } = show(repo, branch, world.layout.ledger.replace(/^\/+|\/+$/g, ""));
  if (!found)
    return null;
  try {
    return parseLedger(text, branch).entries[pattern] ?? null;
  } catch {
    return null;
  }
}
function servedBy(staged, prior) {
  if (staged && staged.served_by)
    return staged.served_by;
  return prior ? prior.served_by : null;
}
function rowType(entry) {
  if (!entry)
    return null;
  return entry.served_by ? entry.served_by.type : entry.artifact_type;
}
function migrating(staged, prior) {
  const branchType = rowType(staged);
  const baseType = rowType(prior);
  return branchType !== null && baseType !== null && branchType !== baseType;
}
async function run(world, cfg, opts) {
  const report = {
    world: world.name,
    dry_run: !opts.apply,
    staged: [],
    merged: [],
    gated_out: {},
    dropped: {},
    started: nowIso(),
    finished: null,
    error: null
  };
  const target = targetRoot(world);
  const items = reflections2(world, opts.extraDirs ?? []);
  const groups = new Map(cluster(items).map((c) => [c.pattern, c.items]));
  const planned = plan(world, cfg, { extraDirs: opts.extraDirs ?? [], cards: opts.cards, items, enforceCap: false });
  const cap = cfg.promotion.per_run_cap;
  const actionable = [];
  for (const action of planned.actions) {
    if (action.action === "below-threshold")
      report.dropped[action.pattern] = action.count;
    else if (action.action === "promote" || action.action === "refine")
      actionable.push(action);
  }
  if (!opts.apply) {
    report.staged = actionable.slice(0, cap).map((a) => a.pattern);
    for (const a of actionable.slice(cap))
      report.gated_out[a.pattern] = `over the per-run cap of ${cap}`;
    report.finished = nowIso();
    return report;
  }
  if (!isRepo(target)) {
    if (resolve4(target) === resolve4(defaultTarget(world.name))) {
      ensureRepo(target);
    } else {
      report.error = `${target} is not a git repository; point the world's \`target\` at one or clear it to use the built-in learned/ repo`;
      report.finished = nowIso();
      return report;
    }
  }
  const chat2 = opts.chat ?? chat;
  const defaultRef = defaultBranch(target);
  const payloads = loadPayloadCorpus(world);
  const ledger = loadLedger2(world);
  const ledgerRel = world.layout.ledger.replace(/^\/+|\/+$/g, "");
  for (const action of actionable) {
    if (report.staged.length >= cap) {
      report.gated_out[action.pattern] = `over the per-run cap of ${cap}`;
      continue;
    }
    try {
      await stageOne(world, cfg, report, action, groups.get(action.pattern) ?? [], chat2, {
        target,
        defaultRef,
        payloads,
        ledger,
        ledgerRel,
        gateRunner: opts.gateRunner
      });
    } catch (e) {
      report.gated_out[action.pattern] = `staging failed: ${describe2(e)}`;
    }
  }
  report.finished = nowIso();
  return report;
}
async function stageOne(world, cfg, report, action, items, chat, ctx) {
  const pattern = action.pattern;
  const sources = sourcesText(items);
  const lessons = lessonTexts(items);
  if (action.action === "refine" && action.reason) {
    lessons.push(`Artifact feedback: ${action.reason}`);
  }
  const branch = branchName(world.name, pattern);
  const prior = ctx.ledger.entries[pattern] ?? null;
  const stagedEntry = branchEntry(world, ctx.target, branch, pattern);
  const served = servedBy(stagedEntry, prior);
  let forcedType = served ? served.type : null;
  if (forcedType === "none") {
    forcedType = null;
  }
  let existing = forcedType ? readArtifact(world, forcedType, pattern) || null : null;
  if (existing && isPlaceholderBody(forcedType, existing)) {
    existing = null;
  }
  if (forcedType === "rule") {
    const problem = ruleProblem(world);
    if (problem) {
      report.gated_out[pattern] = `rule target not writable: ${problem}`;
      return;
    }
  }
  let raw;
  try {
    raw = await chat("drafter", draftMessages(pattern, lessons, existing, forcedType), {
      world,
      jsonMode: true
    });
  } catch (e) {
    report.gated_out[pattern] = `draft failed: ${describe2(e)}`;
    return;
  }
  let [body, answer] = parseDraft(raw, { forcedType });
  let routedType;
  let routedReason;
  if (forcedType !== null) {
    routedType = forcedType;
    routedReason = "already served by this artifact";
  } else {
    const result = route(answer, sources, ctx.payloads, { gateRunner: ctx.gateRunner });
    routedType = result.artifact_type;
    routedReason = result.reason;
  }
  if (routedType === "none") {
    report.gated_out[pattern] = `router: ${routedReason}`;
    return;
  }
  if (routedType === "rule") {
    const problem = ruleProblem(world);
    if (problem) {
      report.gated_out[pattern] = `rule target not writable: ${problem}`;
      return;
    }
  }
  if (forcedType === null && routedType !== draftedType(answer)) {
    try {
      raw = await chat("drafter", draftMessages(pattern, lessons, null, routedType), {
        world,
        jsonMode: true
      });
    } catch (e) {
      report.gated_out[pattern] = `redraft failed after the router selected ${routedType} (${routedReason}): ${describe2(e)}`;
      return;
    }
    [body] = parseDraft(raw, { forcedType: routedType });
  }
  if (routedType === "rule" && typeof body === "string")
    body = stripRuleTag(body, pattern);
  const problems = lint(routedType, body, pattern, sources);
  if (problems.length > 0) {
    let reason = "artifact-lint: " + problems.join("; ");
    if (forcedType === null)
      reason += `; router: ${routedReason}`;
    report.gated_out[pattern] = reason;
    return;
  }
  const dirty = dirtyPaths(ctx.target, artifactPrefixes(world));
  if (dirty.length > 0) {
    report.gated_out[pattern] = `repo integrity: uncommitted changes under a routed artifact path (${dirty.join(", ")}); commit or discard them`;
    return;
  }
  const judgeBody = typeof body === "string" ? body : hookText(body);
  let verdictRaw;
  try {
    verdictRaw = await chat("judge", judgeMessages(pattern, routedType, judgeBody, lessons), {
      world,
      jsonMode: true
    });
  } catch (e) {
    report.gated_out[pattern] = `judge failed: ${describe2(e)}`;
    return;
  }
  const [passed, why] = parseVerdict(verdictRaw);
  if (!passed) {
    report.gated_out[pattern] = `judge: ${why}`;
    return;
  }
  const rel = artifactRel(world, routedType, pattern);
  const autoMerge = cfg.promotion.auto_merge && world.llm !== "local";
  const entry = {
    pattern,
    promoted_at_count: action.count,
    rejected_at_count: prior ? prior.rejected_at_count : 0,
    status: autoMerge ? "promoted" : "staged",
    artifact_type: routedType,
    served_by: { type: routedType, path: rel },
    last_updated: nowIso(),
    promoted_at: autoMerge ? (prior?.status === "promoted" ? prior.promoted_at : null) ?? nowIso() : prior?.promoted_at ?? null,
    commit: null,
    feedback: null
  };
  if (refExists(ctx.target, `refs/heads/${branch}`) && !migrating(stagedEntry, prior)) {
    git(ctx.target, ["branch", "-q", "-f", branch, ctx.defaultRef]);
  }
  const verb = action.action === "refine" ? "refine" : "promote";
  const message = `feat(${routedType}): ${verb} ${pattern} (auto, gated)`;
  const sha = withScratchWorktree(ctx.target, branch, ctx.defaultRef, (tree) => {
    if (routedType === "rule")
      ensureRulesFile(world, tree);
    writeArtifact(world, routedType, pattern, body, tree);
    if (routedType === "rule") {
      const diff = git(tree, ["diff", ctx.defaultRef, "--", rel], { check: false });
      const foreign = foreignRuleTags(diff, pattern);
      if (foreign.length > 0)
        throw new Error(`${rel} also changes rule(s) for ${foreign.join(", ")}`);
    }
    const treeLedger = loadLedger(join13(tree, ctx.ledgerRel));
    treeLedger.entries[pattern] = entry;
    saveLedger(join13(tree, ctx.ledgerRel), treeLedger);
    git(tree, ["add", "--", rel, ctx.ledgerRel]);
    git(tree, ["commit", "-q", "-m", message]);
    return git(tree, ["rev-parse", "HEAD"]);
  });
  entry.commit = sha.slice(0, 12);
  ctx.ledger.entries[pattern] = entry;
  report.staged.push(pattern);
  if (autoMerge)
    autoMergeBranch(report, ctx.target, ctx.defaultRef, branch, pattern);
}
function autoMergeBranch(report, target, defaultRef, branch, pattern) {
  const current = currentBranch(target);
  if (current !== defaultRef) {
    report.gated_out[pattern] = `staged on ${branch}; auto-merge needs ${defaultRef} checked out, and the target is on ${current || "an unknown branch"}`;
    return;
  }
  try {
    git(target, ["merge", "-q", "--ff-only", branch]);
  } catch (e) {
    if (!(e instanceof GitError))
      throw e;
    report.gated_out[pattern] = `staged on ${branch}; auto-merge failed: ${e.message}`;
    return;
  }
  report.merged.push(pattern);
}
function ruleProblem(world) {
  try {
    const rules = join13(targetRoot(world), world.layout.rules_file.replace(/^\/+|\/+$/g, ""));
    if (!existsSync7(rules)) {
      if (ownsRulesFile(world))
        return null;
      return `${rules} does not exist; add it with a ${RULE_START} / ${RULE_END} marker pair to opt this repo into rule writes`;
    }
    return rulesProblem(world);
  } catch (e) {
    return `could not check writability: ${describe2(e)}`;
  }
}
function hookText(body) {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return String(body["text"] ?? "");
  }
  return String(body);
}
// packages/review/src/index.ts
var exports_src6 = {};
__export(exports_src6, {
  DIGEST_PREFIX: () => DIGEST_PREFIX,
  accept: () => accept,
  detail: () => detail,
  diff: () => diff,
  inventory: () => inventory,
  queue: () => queue2,
  rehome: () => rehome,
  reject: () => reject,
  relink: () => relink,
  retire: () => retire,
  setRemoteOps: () => setRemoteOps,
  setScratchWorktree: () => setScratchWorktree,
  snapshot: () => snapshot
});
import { lstatSync as lstatSync2, mkdirSync as mkdirSync5, readlinkSync, symlinkSync, unlinkSync as unlinkSync3, writeFileSync as writeFileSync5 } from "fs";
import { existsSync as existsSync8 } from "fs";
import { dirname as dirname6, join as join16, resolve as resolve6 } from "path";

// packages/worker/src/index.ts
var exports_src5 = {};
__export(exports_src5, {
  Lock: () => Lock,
  MAX_ATTEMPTS: () => MAX_ATTEMPTS,
  eligible: () => eligible,
  loop: () => loop,
  moveToTerminal: () => moveToTerminal,
  pruneQueueBucket: () => pruneQueueBucket,
  reapSessionDir: () => reapSessionDir,
  reapStaleSessionDirs: () => reapStaleSessionDirs,
  runOnce: () => runOnce,
  skipSession: () => skipSession,
  status: () => status2,
  withLock: () => withLock
});
import { closeSync, openSync, readdirSync as readdirSync9, rmSync as rmSync4, statSync as statSync8, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4, writeSync } from "fs";
import { dirname as dirname5, join as join15 } from "path";

// packages/worker/src/outline.ts
import { readdirSync as readdirSync8 } from "fs";
import { basename as basename2, join as join14 } from "path";
async function exportNew(world, _cfg) {
  if (world.outline === null)
    return { skipped: "not configured" };
  const apiKey = process.env[world.outline.api_key_env];
  if (!apiKey)
    return { exported: 0, errors: [`env var ${world.outline.api_key_env} is not set`] };
  const markerPath = join14(stateDir(), `outline-exported-${world.name}.txt`);
  const exportedIds = readMarker(markerPath);
  const errors = [];
  let exported = 0;
  const dir = reflectionsDir(world.name);
  let names;
  try {
    names = readdirSync8(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return { exported, errors };
  }
  for (const name of names) {
    const rid = basename2(name, ".md");
    if (exportedIds.has(rid))
      continue;
    let body;
    try {
      body = readText(join14(dir, name));
    } catch (e) {
      errors.push(`${rid}: ${e.message}`);
      continue;
    }
    const payload = { title: rid, text: body, collectionId: world.outline.collection_id, publish: true };
    if (world.outline.parent_document_id)
      payload["parentDocumentId"] = world.outline.parent_document_id;
    try {
      await post(world.outline.base_url, apiKey, payload);
    } catch (e) {
      errors.push(`${rid}: ${e.constructor.name}: ${e.message}`);
      continue;
    }
    appendMarker(markerPath, rid);
    exportedIds.add(rid);
    exported += 1;
  }
  return { exported, errors };
}
async function post(baseUrl, apiKey, payload) {
  const url = baseUrl.replace(/\/+$/, "") + "/api/documents.create";
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1e4)
  });
  if (!resp.ok)
    throw new Error(`outline ${resp.status} ${await resp.text()}`);
}
function readMarker(path) {
  const text = readTextOr(path, "");
  const ids = text.split(`
`).map((l) => l.trim()).filter((l) => l.length > 0);
  return new Set(ids);
}
function appendMarker(path, rid) {
  appendLine(path, rid);
}

// packages/worker/src/index.ts
var MAX_ATTEMPTS = 3;
function readPid(path) {
  const text = readTextOr(path, "").trim();
  if (!text)
    return null;
  const pid = Number.parseInt(text, 10);
  return Number.isFinite(pid) ? pid : null;
}
function pidAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e;
    return err.code === "EPERM";
  }
}
var PID_SETTLE_TRIES = 5;
var PID_SETTLE_MS = 10;
var RECLAIM_SETTLE_MS = 60;
function settledPid(path) {
  for (let i = 0;i < PID_SETTLE_TRIES; i++) {
    const pid = readPid(path);
    if (pid !== null)
      return pid;
    if (!exists(path))
      return null;
    Bun.sleepSync(PID_SETTLE_MS);
  }
  return readPid(path);
}

class Lock {
  path;
  constructor() {
    this.path = workerLockFile();
  }
  acquire() {
    ensureDir(dirname5(this.path));
    if (this.create())
      return;
    const pid = settledPid(this.path);
    if (pid !== null && pidAlive2(pid))
      throw new LockHeld(`worker lock held: ${this.path}`);
    atomicWrite(this.path, String(process.pid));
    Bun.sleepSync(RECLAIM_SETTLE_MS);
    if (readPid(this.path) !== process.pid)
      throw new LockHeld(`worker lock held: ${this.path}`);
  }
  release() {
    try {
      writeFileSync4(this.path, "", "utf8");
    } catch {}
    try {
      unlinkSync2(this.path);
    } catch {}
  }
  static held() {
    const pid = readPid(workerLockFile());
    return pid !== null && pidAlive2(pid);
  }
  create() {
    let fd;
    try {
      fd = openSync(this.path, "wx");
    } catch (e) {
      if (e.code === "EEXIST")
        return false;
      throw e;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  }
}
async function withLock(fn) {
  const lock = new Lock;
  lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
function moveToTerminal(entry, to, result) {
  moveEntry(entry, "pending", to, result);
  reapSessionDir(entry.session_id);
}
function reapSessionDir(sessionId) {
  const dir = sessionDir(sessionId);
  if (!exists(dir))
    return;
  rmSync4(dir, { recursive: true, force: true });
  log({ action: "reap_session_dir", session_id: sessionId, result: "removed" });
}
function reapStaleSessionDirs(now, maxAgeDays = 7, limit = 500) {
  const root = join15(stateDir(), "sessions");
  let names;
  try {
    names = readdirSync9(root).sort();
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - maxAgeDays * 86400000;
  let removed = 0;
  for (const name of names) {
    if (removed >= limit)
      break;
    const p = join15(root, name);
    let st;
    try {
      st = statSync8(p);
    } catch {
      continue;
    }
    if (!st.isDirectory())
      continue;
    if (st.mtimeMs < cutoff) {
      rmSync4(p, { recursive: true, force: true });
      removed += 1;
    }
  }
  if (removed)
    log({ action: "reap_stale_sessions", result: `removed ${removed}` });
  return removed;
}
function pruneQueueBucket(bucket, keep = 500) {
  const entries = listQueue(bucket);
  if (entries.length <= keep)
    return 0;
  const sorted = [...entries].sort((a, b) => a.last_stop < b.last_stop ? 1 : a.last_stop > b.last_stop ? -1 : 0);
  const stale = sorted.slice(keep);
  for (const e of stale) {
    try {
      rmSync4(entryPath(bucket, e.session_id), { force: true });
    } catch {}
  }
  log({ action: "prune_queue", bucket, result: `removed ${stale.length}` });
  return stale.length;
}
function skipSession(sessionId) {
  const entry = loadEntry("pending", sessionId);
  if (entry === null)
    return false;
  moveToTerminal(entry, "done", "skipped by operator");
  return true;
}
var NO_TRANSCRIPT = "skipped: transcript not persisted";
function eligible(entry, cfg, now) {
  if (!exists(entry.transcript_path))
    return [false, NO_TRANSCRIPT];
  let idleOk = entry.ended;
  if (!idleOk) {
    const mtime = mtimeMs(entry.transcript_path);
    if (mtime === null)
      return [false, NO_TRANSCRIPT];
    idleOk = (now.getTime() - mtime) / 60000 >= cfg.worker.idle_minutes;
  }
  if (!idleOk)
    return [false, "not idle"];
  const toolUses = entry.tool_uses || countToolUses(entry.transcript_path);
  if (toolUses < cfg.worker.min_tool_uses)
    return [false, "below min_tool_uses"];
  return [true, "eligible"];
}
function isTransient(e) {
  return e instanceof ProviderError || e instanceof ConfigError;
}
async function runOnce(cfg, opts = {}) {
  const config = cfg ?? loadConfig();
  const started = Date.now();
  const summary = { reflected: [], failed: [], skipped: [], curriculum: {}, duration_s: 0 };
  try {
    await withLock(async () => {
      writeHookSnapshot(config);
      const now = new Date;
      const worlds = config.worlds.filter((w) => opts.worldName === undefined || w.name === opts.worldName);
      const worldByName = new Map(config.worlds.map((w) => [w.name, w]));
      if (opts.reflect ?? true) {
        await reflectPending(config, worldByName, opts.worldName, now, opts.chat, summary);
      }
      reapStaleSessionDirs(now);
      pruneQueueBucket("done");
      pruneQueueBucket("failed");
      for (const world of worlds) {
        await runCurriculumIfDue(world, config, opts.curriculum ?? true, now, summary);
        try {
          rebuild(world, config);
        } catch (e) {
          log({ action: "feedback", world: world.name, result: `failed: ${e.message}` });
        }
        if (world.outline) {
          try {
            await exportNew(world, config);
          } catch (e) {
            log({ action: "outline", world: world.name, result: `failed: ${e.message}` });
          }
        }
      }
      summary.duration_s = Math.round((Date.now() - started) / 1000 * 1000) / 1000;
      writeJson(join15(stateDir(), "worker-status.json"), { last_run: nowIso(), last_summary: summary });
    });
  } catch (e) {
    if (e instanceof LockHeld)
      return { reflected: [], failed: [], skipped: [], curriculum: {}, duration_s: 0, locked: true };
    throw e;
  }
  return summary;
}
async function reflectPending(cfg, worldByName, worldName, now, chat, summary) {
  for (const entry of listQueue("pending")) {
    if (worldName !== undefined && entry.world !== worldName)
      continue;
    const world = worldByName.get(entry.world);
    if (world === undefined) {
      const reason = `failed: unknown world ${JSON.stringify(entry.world)}`;
      moveToTerminal(entry, "failed", reason);
      summary.failed.push(entry.session_id);
      log({ action: "reflect", session_id: entry.session_id, result: reason });
      continue;
    }
    const [ok, reason] = eligible(entry, cfg, now);
    if (!ok) {
      if (reason.startsWith("failed")) {
        moveToTerminal(entry, "failed", reason);
        summary.failed.push(entry.session_id);
      } else if (reason.startsWith("skipped")) {
        moveToTerminal(entry, "done", reason);
        summary.skipped.push(entry.session_id);
      } else {
        summary.skipped.push(entry.session_id);
      }
      log({ action: "reflect", session_id: entry.session_id, result: reason });
      continue;
    }
    try {
      const result = await reflectSession(entry, { cfg, world, chat });
      const outcome = result.recorded ? `recorded:${result.pattern}` : result.reason || "not recorded";
      moveToTerminal(entry, "done", outcome);
      summary.reflected.push(entry.session_id);
      log({ action: "reflect", session_id: entry.session_id, result: "done" });
    } catch (e) {
      const err = e;
      const reason = `failed: ${err.constructor.name}: ${err.message}`.slice(0, 300);
      if (isTransient(e) && entry.attempts + 1 < MAX_ATTEMPTS) {
        const updated = { ...entry, attempts: entry.attempts + 1, result: reason };
        writeEntry("pending", updated);
        summary.skipped.push(entry.session_id);
        log({ action: "reflect", session_id: entry.session_id, result: `retry later (${updated.attempts}/${MAX_ATTEMPTS}): ${reason}` });
        continue;
      }
      moveToTerminal(entry, "failed", reason);
      summary.failed.push(entry.session_id);
      log({ action: "reflect", session_id: entry.session_id, result: reason });
    }
  }
}
async function runCurriculumIfDue(world, cfg, curriculumEnabled, now, summary) {
  const marker = join15(stateDir(), `last-curriculum-${world.name}`);
  if (!curriculumEnabled || !curriculumDue(marker, cfg.worker.curriculum_interval_minutes, now))
    return;
  try {
    const report = await run(world, cfg, { apply: true });
    summary.curriculum[world.name] = report;
  } catch (e) {
    summary.curriculum[world.name] = { error: e.message };
  }
  ensureDir(dirname5(marker));
  writeFileSync4(marker, now.toISOString(), "utf8");
}
function curriculumDue(markerPath, intervalMinutes, now) {
  const mtime = mtimeMs(markerPath);
  if (mtime === null)
    return true;
  return (now.getTime() - mtime) / 60000 >= intervalMinutes;
}
function log(payload) {
  const line = { ts: nowIso(), ...payload };
  appendLine(logFile("worker"), JSON.stringify(line));
}
function status2() {
  let lastRun = null;
  let lastSummary = null;
  const raw = readJsonOr(join15(stateDir(), "worker-status.json"), null);
  if (raw) {
    lastRun = raw.last_run ?? null;
    lastSummary = raw.last_summary ?? null;
  }
  const lastCurriculum = {};
  let names = [];
  try {
    names = readdirSync9(stateDir());
  } catch {}
  for (const name of names) {
    if (!name.startsWith("last-curriculum-"))
      continue;
    const world = name.slice("last-curriculum-".length);
    const mtime = mtimeMs(join15(stateDir(), name));
    if (mtime !== null)
      lastCurriculum[world] = new Date(mtime).toISOString();
  }
  return {
    lock_held: Lock.held(),
    lock_pid: readPid(workerLockFile()),
    pending: listQueue("pending").length,
    done: listQueue("done").length,
    failed: listQueue("failed").length,
    last_run: lastRun,
    last_summary: lastSummary,
    last_curriculum: lastCurriculum
  };
}
async function loop(cfg, intervalS) {
  for (;; ) {
    await runOnce(cfg);
    await sleep(intervalS * 1000);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// packages/review/src/remote.ts
var GH_TIMEOUT_MS = 60000;
var NET_TIMEOUT_MS = 120000;
var realOps = {
  hasGh: () => hasGh(),
  gh(repo, args) {
    const exe = Bun.which("gh");
    if (exe === null)
      throw new ReviewError("gh not found on PATH");
    const proc = Bun.spawnSync([exe, ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" }
    });
    if (proc.exitCode !== 0) {
      throw new ReviewError(`gh ${args.join(" ")}: ${proc.stderr.toString().trim() || "failed"}`);
    }
    return proc.stdout.toString().trim();
  },
  push(repo, args) {
    git(repo, ["push", ...args], { timeout: NET_TIMEOUT_MS });
  },
  lsRemote(repo, ref) {
    const line = git(repo, ["ls-remote", "origin", `refs/heads/${ref}`], {
      check: false,
      timeout: NET_TIMEOUT_MS
    });
    return line ? line.split("\t")[0].trim() : "";
  }
};
var override2 = null;
function setRemoteOps(ops) {
  override2 = ops;
}
function ops() {
  return override2 ? { ...realOps, ...override2 } : realOps;
}
function publish(world, repo, defaultRef, branch, pattern, artifactType) {
  const out = {};
  if (world.remote === "none")
    return out;
  const io = ops();
  if (world.remote === "push") {
    try {
      io.push(repo, ["-q", "origin", defaultRef]);
      out.pushed = true;
    } catch (e) {
      out.remote_error = `merged locally, not pushed: ${e.message}`;
    }
    return out;
  }
  if (!io.hasGh()) {
    out.remote_error = "gh not found on PATH; the artifact is merged locally but no pull request was opened";
    return out;
  }
  try {
    io.push(repo, ["-q", "-u", "origin", branch]);
    const headAtCreate = git(repo, ["rev-parse", branch], { check: false });
    const baseAtCreate = io.lsRemote(repo, defaultRef);
    const title = `feat(${artifactType}): ${pattern} (reviewed)`;
    const body = `Promotes \`${pattern}\` from the curriculum loop in world \`${world.name}\`. ` + "Reviewed in the loop UI: the artifact body, its source reflections and the full diff.";
    io.gh(repo, ["pr", "create", "--base", defaultRef, "--head", branch, "--title", title, "--body", body]);
    const listed = JSON.parse(io.gh(repo, ["pr", "list", "--head", branch, "--base", defaultRef, "--state", "open", "--json", "number,url", "--limit", "1"]) || "[]");
    const first = Array.isArray(listed) && listed.length > 0 ? listed[0] : null;
    if (!first) {
      out.remote_error = `opened a pull request for ${branch} but could not read it back`;
      return out;
    }
    out.pr = Number(first["number"]);
    out.pr_url = String(first["url"] ?? "");
    const moved = prMoved(io, repo, defaultRef, out.pr, headAtCreate, baseAtCreate);
    if (moved) {
      out.remote_error = moved;
      return out;
    }
    io.gh(repo, ["pr", "merge", String(out.pr), "--merge"]);
  } catch (e) {
    out.remote_error = `merged locally, but the pull request step failed: ${e.message}`;
  }
  return out;
}
function prMoved(io, repo, defaultRef, number, headAtCreate, baseAtCreate) {
  let headNow;
  try {
    const raw = JSON.parse(io.gh(repo, ["pr", "view", String(number), "--json", "headRefOid"]) || "{}");
    headNow = String(raw?.["headRefOid"] ?? "");
  } catch (e) {
    return `could not re-read pull request #${number} before merging it (${e.message}); ` + "merged locally, the pull request is left open";
  }
  if (headNow !== headAtCreate) {
    return `pull request #${number} is at ${headNow.slice(0, 12) || "an unreadable head"}, not the ` + `${headAtCreate.slice(0, 12) || "unknown"} commit that was reviewed and pushed; ` + "merged locally, the pull request is left open";
  }
  const baseNow = io.lsRemote(repo, defaultRef);
  if (baseNow !== baseAtCreate) {
    return `origin/${defaultRef} moved from ${baseAtCreate.slice(0, 12) || "nothing"} to ` + `${baseNow.slice(0, 12) || "nothing"} after the pull request was opened; ` + "merged locally, the pull request is left open";
  }
  return null;
}

// packages/review/src/snapshot.ts
import { createHash as createHash2 } from "crypto";
import { resolve as resolve5 } from "path";
var DIGEST_PREFIX = `sil.accept.review-state
`;
function ledgerRel(world) {
  return world.layout.ledger.replace(/^\/+|\/+$/g, "");
}
function snapshot(world, repo, defaultRef, pattern) {
  const branch = branchName(world.name, pattern);
  const branchSha = git(repo, ["rev-parse", "--verify", `${branch}^{commit}`], { check: false });
  const baseSha = git(repo, ["rev-parse", "--verify", `${defaultRef}^{commit}`], { check: false });
  let digest = "";
  if (branchSha && baseSha) {
    const canonical = JSON.stringify({
      base_ref: defaultRef,
      base_sha: baseSha,
      branch,
      branch_sha: branchSha,
      pattern,
      repo: resolve5(repo),
      version: 1,
      world: world.name
    });
    digest = createHash2("sha256").update(DIGEST_PREFIX + canonical, "utf8").digest("hex");
  }
  return {
    world: world.name,
    repo,
    pattern,
    branch,
    branch_sha: branchSha,
    base_ref: defaultRef,
    base_sha: baseSha,
    reviewed_state: digest
  };
}
function branchEntry2(world, repo, ref, pattern) {
  const { found, text } = show(repo, ref, ledgerRel(world));
  if (!found)
    return null;
  try {
    return parseLedger(text, ref).entries[pattern] ?? null;
  } catch {
    return null;
  }
}
function entryType(entry) {
  if (!entry)
    return "skill";
  if (entry.served_by && entry.served_by.type !== "none")
    return entry.served_by.type;
  return entry.artifact_type;
}
function artifactBody(world, repo, ref, artifactType, pattern) {
  const rel = artifactRel(world, artifactType, pattern);
  if (!rel)
    return { found: artifactType === "none", body: "" };
  const { found, text } = show(repo, ref, rel);
  if (artifactType === "rule") {
    return { found, body: text ? ruleBulletInText(text, pattern) : "" };
  }
  return { found, body: text };
}
function foreignChanges(world, repo, snap, pattern, artifactType) {
  const allowed = new Set(allowedPaths(world, pattern));
  const rulesRel = artifactRel(world, "rule", pattern);
  const touched = commitPaths(repo, snap.base_sha, snap.branch_sha);
  let ruleTags = [];
  if (touched.includes(rulesRel)) {
    const diff = git(repo, ["diff", `${snap.base_sha}...${snap.branch_sha}`, "--", rulesRel], { check: false });
    ruleTags = foreignRuleTags(diff, pattern);
    const ownsIt = artifactType === "rule" ? ruleTags.length === 0 : rulesDiffOwnedBy(diff, pattern);
    if (!ownsIt)
      allowed.delete(rulesRel);
  }
  return { paths: touched.filter((p) => !allowed.has(p)).sort(), ruleTags };
}

// packages/review/src/index.ts
var scratchWorktree = null;
function setScratchWorktree(fn) {
  scratchWorktree = fn;
}
function withTree(repo, branch, base, fn) {
  return (scratchWorktree ?? withScratchWorktree)(repo, branch, base, fn);
}
function withWorkerLock(fn) {
  const lock = new Lock;
  try {
    lock.acquire();
  } catch (e) {
    if (e instanceof LockHeld)
      throw new ReviewError("worker is running, retry in a moment");
    throw new ReviewError(`cannot take the worker lock: ${e.message}`);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}
function queue2(world, _cfg) {
  const repo = targetRoot(world);
  if (!isRepo(repo))
    return [];
  const defaultRef = defaultBranch(repo);
  const prefix = `curriculum/${world.name.toLowerCase()}/`;
  const listing = git(repo, ["branch", "--list", `${prefix}*`, "--no-merged", defaultRef, "--format=%(refname:short)"], { check: false });
  const rows = [];
  for (const line of listing.split(`
`)) {
    const branch = line.trim();
    if (!branch.startsWith(prefix))
      continue;
    const pattern = branch.slice(prefix.length);
    const entry = branchEntry2(world, repo, branch, pattern);
    const atype = entryType(entry);
    rows.push({
      world: world.name,
      pattern,
      branch,
      artifact_type: atype,
      artifact_path: artifactRel(world, atype, pattern) || null,
      count: entry ? entry.promoted_at_count : 0,
      staged_at: entry ? entry.last_updated : null,
      commit: git(repo, ["rev-parse", "--short", branch], { check: false }) || null
    });
  }
  rows.sort((a, b) => a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0);
  return rows;
}
function foreignProblem(world, repo, snap, pattern, artifactType) {
  const { paths: foreign, ruleTags } = foreignChanges(world, repo, snap, pattern, artifactType);
  if (ruleTags.length > 0) {
    return `${snap.branch} rewrites the rule bullet of ${ruleTags.join(", ")} in ` + `${artifactRel(world, "rule", pattern)}. Every pattern's rule lives in that file and each one is ` + "reviewed on its own branch. Commit the other bullet(s) separately, then accept.";
  }
  if (foreign.length > 0) {
    return `${snap.branch} changes ${foreign.length} file(s) that do not belong to ${JSON.stringify(pattern)}: ` + `${foreign.join(", ")}. Accepting would publish them inside this artifact's review. ` + "Commit them separately, then accept.";
  }
  return null;
}
function detail(world, _cfg, pattern, opts = {}) {
  const repo = targetRoot(world);
  const defaultRef = defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha)
    throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to review`);
  const entry = branchEntry2(world, repo, snap.branch_sha, pattern);
  const atype = entryType(entry);
  const { found, body } = artifactBody(world, repo, snap.branch_sha, atype, pattern);
  let blocked = null;
  if (isPlaceholderBody(atype, body)) {
    blocked = `${snap.branch} still carries the re-home placeholder for ${JSON.stringify(pattern)} (${atype}); ` + "no real draft has been written yet. Wait for the next run to redraft it, or reject and re-route.";
  } else {
    blocked = foreignProblem(world, repo, snap, pattern, atype);
  }
  const sources = reflections2(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).map((r) => r.id);
  return {
    world: world.name,
    pattern,
    branch: snap.branch,
    artifact_type: atype,
    artifact_path: artifactRel(world, atype, pattern) || null,
    count: entry ? entry.promoted_at_count : 0,
    staged_at: entry ? entry.last_updated : null,
    commit: snap.branch_sha.slice(0, 12),
    body: found ? body : "",
    sources,
    reviewed_state: snap.reviewed_state,
    accept_blocked: blocked
  };
}
function diff(world, _cfg, pattern) {
  const repo = targetRoot(world);
  const defaultRef = defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha || !snap.base_sha)
    throw new ReviewError(`${snap.branch} has no resolvable commit; no diff`);
  const text = git(repo, ["diff", `${snap.base_sha}...${snap.branch_sha}`], { check: false });
  return { world: world.name, pattern, diff: text, reviewed_state: snap.reviewed_state };
}
function inventory(world, _cfg, opts = {}) {
  const ledger = loadLedger2(world);
  const counts = new Map;
  for (const reflection of reflections2(world, opts.extraDirs ?? [])) {
    counts.set(reflection.pattern, (counts.get(reflection.pattern) ?? 0) + 1);
  }
  const cards = scorecardByPattern(scorecards2(world));
  const rows = [];
  for (const pattern of Object.keys(ledger.entries).sort()) {
    const entry = ledger.entries[pattern];
    rows.push({
      pattern,
      artifact_type: entry.artifact_type,
      served_by: entry.served_by ? entry.served_by.path : null,
      status: entry.status,
      reflections: counts.get(pattern) ?? 0,
      scorecard: cards.get(pattern) ?? null
    });
  }
  return rows;
}
function requireLiveReady(world, repo, defaultRef) {
  const branch = currentBranch(repo);
  if (branch !== defaultRef) {
    throw new ReviewError(`${repo} is on ${branch || "a detached HEAD"}, not ${defaultRef}. Check ${defaultRef} out and retry; nothing was changed.`);
  }
  const dirty = dirtyPaths(repo, artifactPrefixes(world), { includeUntracked: true });
  if (dirty.length > 0) {
    throw new ReviewError(`${repo} has uncommitted or untracked files under ${dirty.join(", ")}. Commit or discard them and retry; nothing was changed.`);
  }
}
function accept(world, cfg, pattern, reviewedState) {
  return withWorkerLock(() => acceptInner(world, cfg, pattern, reviewedState));
}
function acceptInner(world, _cfg, pattern, reviewedState) {
  const repo = targetRoot(world);
  if (!isRepo(repo))
    throw new ReviewError(`${repo} is not a git repository`);
  const defaultRef = defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha)
    throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to accept`);
  if (!reviewedState || reviewedState !== snap.reviewed_state) {
    throw new ReviewError("reviewed state changed since preview; reload the review and accept again");
  }
  const entry = branchEntry2(world, repo, snap.branch_sha, pattern);
  const atype = entryType(entry);
  const { body } = artifactBody(world, repo, snap.branch_sha, atype, pattern);
  if (isPlaceholderBody(atype, body)) {
    throw new ReviewError(`${snap.branch} still carries the re-home placeholder for ${JSON.stringify(pattern)} (${atype}); no real draft has been written yet`);
  }
  const problem = foreignProblem(world, repo, snap, pattern, atype);
  if (problem)
    throw new ReviewError(problem);
  requireLiveReady(world, repo, defaultRef);
  const rel = ledgerRel(world);
  const prepared = withTree(repo, snap.branch, defaultRef, (tree) => {
    const checkedOut = git(tree, ["rev-parse", "HEAD"], { check: false });
    if (checkedOut !== snap.branch_sha) {
      throw new ReviewError(`${snap.branch} moved from ${snap.branch_sha.slice(0, 12)} to ${checkedOut.slice(0, 12) || "an unreadable commit"} ` + "while accept was running; reload the review and accept again. Nothing was merged.");
    }
    if (!isAncestor(repo, snap.base_sha, snap.branch_sha)) {
      mergeBaseIntoBranch(world, repo, tree, snap, pattern, rel);
    }
    const merged = ledgerAt(world, repo, snap.base_sha);
    const row = entry ?? merged.entries[pattern] ?? null;
    if (row) {
      merged.entries[pattern] = {
        ...row,
        status: "promoted",
        commit: snap.branch_sha.slice(0, 12),
        last_updated: nowIso(),
        promoted_at: row.status === "promoted" ? row.promoted_at ?? nowIso() : nowIso()
      };
    }
    saveLedger(join16(tree, rel), merged);
    git(tree, ["add", "--", rel]);
    git(tree, ["commit", "-q", "-m", `feat(${atype}): ${pattern} (reviewed)`]);
    return git(tree, ["rev-parse", "HEAD"]);
  });
  try {
    git(repo, ["merge", "-q", "--ff-only", prepared]);
  } catch (e) {
    throw new ReviewError(`${defaultRef} could not fast-forward to ${prepared.slice(0, 12)}: ${e.message}. ` + `${snap.branch} now carries that reviewed commit and nothing was merged into ${defaultRef}; ` + "resolve the working tree and accept again.");
  }
  const out = {
    merged: true,
    status: "promoted",
    pattern,
    branch: snap.branch,
    artifact_type: atype,
    commit: prepared.slice(0, 12),
    link: null,
    branch_deleted: false
  };
  try {
    out.link = relink(world, pattern, atype);
  } catch (e) {
    out.link = null;
    out.link_error = e.message;
  }
  Object.assign(out, publish(world, repo, defaultRef, snap.branch, pattern, atype));
  git(repo, ["branch", "-q", "-D", snap.branch], { check: false });
  out.branch_deleted = !refExists(repo, `refs/heads/${snap.branch}`);
  if (!out.branch_deleted) {
    out.branch_error = `${snap.branch} is merged but could not be deleted`;
  }
  return out;
}
function mergeBaseIntoBranch(world, repo, tree, snap, pattern, rel) {
  const rulesRel = artifactRel(world, "rule", pattern);
  try {
    git(tree, ["merge", "--no-ff", "--no-commit", "-q", snap.base_sha]);
  } catch (e) {
    if (!(e instanceof GitError))
      throw e;
    const conflicted = git(tree, ["diff", "--name-only", "--diff-filter=U"], { check: false }).split(`
`).filter((p) => p.trim());
    if (conflicted.length === 0) {
      throw e;
    }
    const shared = new Set([rel, rulesRel].filter((p) => p));
    if (conflicted.some((p) => !shared.has(p))) {
      git(tree, ["merge", "--abort"], { check: false });
      throw new ReviewError(`${snap.branch} conflicts outside the ledger: ${conflicted.join(", ")}`);
    }
    if (conflicted.includes(rulesRel))
      resolveRulesConflict(world, repo, tree, snap, pattern, rulesRel);
  }
}
function resolveRulesConflict(world, repo, tree, snap, pattern, rulesRel) {
  try {
    const base = show(repo, snap.base_sha, rulesRel);
    if (base.found)
      writeFileSync5(join16(tree, rulesRel), base.text, "utf8");
    else
      ensureRulesFile(world, tree);
    const onBranch = show(repo, snap.branch_sha, rulesRel);
    const bullet = ruleBulletInText(onBranch.text, pattern).replace(ruleTag(pattern), "").trim();
    if (bullet)
      writeArtifact(world, "rule", pattern, bullet, tree);
    else
      removeArtifact(world, "rule", pattern, tree);
    git(tree, ["add", "--", rulesRel]);
  } catch (e) {
    git(tree, ["merge", "--abort"], { check: false });
    throw new ReviewError(`${snap.branch} conflicts in ${rulesRel} and it could not be rebuilt from ${snap.base_ref}: ` + `${e.message}. Nothing was merged.`);
  }
}
function ledgerAt(world, repo, ref) {
  const rel = ledgerRel(world);
  const { found, text } = show(repo, ref, rel);
  if (!found)
    return parseLedger("{}");
  try {
    return parseLedger(text, ref);
  } catch (e) {
    throw new ReviewError(`the ledger at ${ref}:${rel} is unreadable; accepting would discard every recorded watermark: ` + `${e.message}. Repair it on the default branch, then accept.`);
  }
}
function reject(world, cfg, pattern, opts = {}) {
  return withWorkerLock(() => rejectInner(world, cfg, pattern, opts));
}
function rejectInner(world, _cfg, pattern, opts) {
  const repo = targetRoot(world);
  const defaultRef = defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (!snap.branch_sha)
    throw new ReviewError(`${snap.branch} has no resolvable commit; nothing to reject`);
  requireLiveReady(world, repo, defaultRef);
  const branchRow = branchEntry2(world, repo, snap.branch_sha, pattern);
  const at = reflections2(world, opts.extraDirs ?? []).filter((r) => r.pattern === pattern).length;
  const rel = ledgerRel(world);
  const sha = commitOnDefault(world, repo, defaultRef, `chore(curriculum): reject ${pattern}`, (tree) => {
    const ledger = loadLedger(join16(tree, rel));
    const prior = ledger.entries[pattern];
    if (prior) {
      ledger.entries[pattern] = { ...prior, rejected_at_count: at, last_updated: nowIso() };
    } else {
      ledger.entries[pattern] = {
        pattern,
        promoted_at_count: 0,
        rejected_at_count: at,
        status: "rejected",
        artifact_type: entryType(branchRow),
        served_by: null,
        last_updated: nowIso(),
        promoted_at: null,
        commit: null,
        feedback: null
      };
    }
    saveLedger(join16(tree, rel), ledger);
    return [rel];
  });
  git(repo, ["branch", "-q", "-D", snap.branch], { check: false });
  return {
    pattern,
    deleted: snap.branch,
    sha: snap.branch_sha,
    rejected_at_count: at,
    commit: sha.slice(0, 12)
  };
}
function commitOnDefault(world, repo, defaultRef, message, mutate) {
  requireLiveReady(world, repo, defaultRef);
  const scratch = `sil-scratch/${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  git(repo, ["branch", scratch, defaultRef]);
  try {
    const sha = withTree(repo, scratch, defaultRef, (tree) => {
      const touched = mutate(tree);
      if (touched.length === 0)
        throw new ReviewError(`nothing to commit for ${JSON.stringify(message)}`);
      git(tree, ["add", "--", ...touched]);
      git(tree, ["commit", "-q", "-m", message]);
      return git(tree, ["rev-parse", "HEAD"]);
    });
    git(repo, ["merge", "-q", "--ff-only", scratch]);
    return sha;
  } finally {
    git(repo, ["branch", "-q", "-D", scratch], { check: false });
  }
}
function stageOnBranch(world, repo, pattern, mutate) {
  const defaultRef = defaultBranch(repo);
  const branch = branchName(world.name, pattern);
  withTree(repo, branch, defaultRef, (tree) => {
    const [touched, message] = mutate(tree);
    if (touched.length === 0)
      throw new ReviewError(`${JSON.stringify(pattern)}: nothing to commit on ${branch}`);
    git(tree, ["add", "--", ...touched]);
    git(tree, ["commit", "-q", "-m", message]);
  });
  return branch;
}
function rehome(world, cfg, pattern, artifactType) {
  return withWorkerLock(() => rehomeInner(world, cfg, pattern, artifactType));
}
function rehomeInner(world, _cfg, pattern, artifactType) {
  const repo = targetRoot(world);
  const rel = ledgerRel(world);
  let newRel = "";
  const branch = stageOnBranch(world, repo, pattern, (tree) => {
    const ledger = loadLedger(join16(tree, rel));
    const entry = ledger.entries[pattern];
    if (!entry)
      throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to re-home`);
    const oldType = entryType(entry);
    if (oldType === artifactType) {
      throw new ReviewError(`${JSON.stringify(pattern)} is already served by ${JSON.stringify(artifactType)}`);
    }
    const touched = [];
    const removed = removeArtifact(world, oldType, pattern, tree);
    if (removed)
      touched.push(removed);
    if (artifactType === "rule")
      ensureRulesFile(world, tree);
    writeArtifact(world, artifactType, pattern, placeholderBody(pattern, artifactType, oldType), tree);
    newRel = artifactRel(world, artifactType, pattern);
    if (newRel)
      touched.push(newRel);
    ledger.entries[pattern] = {
      ...entry,
      artifact_type: artifactType,
      served_by: { type: artifactType, path: newRel },
      status: "staged",
      last_updated: nowIso()
    };
    saveLedger(join16(tree, rel), ledger);
    touched.push(rel);
    return [touched, `feat(${artifactType}): re-home ${pattern} (auto, gated)`];
  });
  return { branch, pattern, artifact_type: artifactType, path: newRel };
}
function retire(world, cfg, pattern) {
  return withWorkerLock(() => retireInner(world, cfg, pattern));
}
function retireInner(world, _cfg, pattern) {
  const repo = targetRoot(world);
  const rel = ledgerRel(world);
  let removed = "";
  const branch = stageOnBranch(world, repo, pattern, (tree) => {
    const ledger = loadLedger(join16(tree, rel));
    const entry = ledger.entries[pattern];
    if (!entry)
      throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to retire`);
    if (entry.status === "retired")
      throw new ReviewError(`${JSON.stringify(pattern)} is already retired`);
    const oldType = entryType(entry);
    removed = removeArtifact(world, oldType, pattern, tree);
    ledger.entries[pattern] = { ...entry, status: "retired", served_by: null, last_updated: nowIso() };
    saveLedger(join16(tree, rel), ledger);
    return [[...removed ? [removed] : [], rel], `feat(${oldType}): retire ${pattern} (auto, gated)`];
  });
  return { branch, pattern, removed };
}
function relink(world, pattern, artifactType) {
  if (artifactType !== "skill" && artifactType !== "agent")
    return null;
  const target = targetRoot(world);
  const rel = artifactRel(world, artifactType, pattern);
  const source = artifactType === "skill" ? dirname6(join16(target, rel)) : join16(target, rel);
  const link = artifactType === "skill" ? join16(claudeConfigDir(), "skills", pattern) : join16(claudeConfigDir(), "agents", `${pattern}.md`);
  mkdirSync5(dirname6(link), { recursive: true });
  let isLink = false;
  try {
    isLink = lstatSync2(link).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (isLink) {
    const current = readlinkSync(link);
    if (!existsSync8(source)) {
      unlinkSync3(link);
      return null;
    }
    if (resolve6(dirname6(link), current) === resolve6(source))
      return link;
    unlinkSync3(link);
  } else if (existsSync8(link)) {
    throw new ReviewError(`${link} already exists and is not a symlink; refusing to replace it. Move it aside and relink.`);
  }
  if (!existsSync8(source))
    return null;
  symlinkSync(source, link, artifactType === "skill" ? "dir" : "file");
  return link;
}

// apps/cli/src/deps.ts
var defaultDeps = {
  worker: exports_src5,
  feedback: exports_src3,
  providers: exports_src2,
  review: exports_src6,
  curriculum: exports_src4
};

// apps/cli/src/commands/aliases.ts
function cmdAliasesList(opts) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const entries = Object.entries(loadAliases(world.name)).sort(([a], [b]) => a < b ? -1 : 1);
  if (entries.length === 0) {
    console.log(`no aliases for world ${world.name}`);
    return 0;
  }
  for (const [alias, canonical] of entries)
    console.log(`${alias.padEnd(30)} -> ${canonical}`);
  return 0;
}
function cmdAliasesSet(alias, canonical, opts) {
  if (!isSlug(alias))
    throw new ValidationError(`alias ${JSON.stringify(alias)} is not a valid slug`);
  if (!isSlug(canonical))
    throw new ValidationError(`canonical ${JSON.stringify(canonical)} is not a valid slug`);
  if (alias === canonical)
    throw new ValidationError(`alias and canonical cannot both be ${JSON.stringify(alias)}`);
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const current = loadAliases(world.name);
  if (Object.hasOwn(current, canonical)) {
    throw new ValidationError(`${JSON.stringify(canonical)} is itself an alias for ${JSON.stringify(current[canonical])}; point ${JSON.stringify(alias)} at ${JSON.stringify(current[canonical])} instead`);
  }
  const next = { ...current, [alias]: canonical };
  const repointed = [];
  for (const [k, v] of Object.entries(current)) {
    if (v === alias) {
      next[k] = canonical;
      repointed.push(k);
    }
  }
  repointed.sort();
  saveAliases(world.name, next);
  console.log(`aliased ${alias} -> ${canonical} in world ${world.name}`);
  for (const k of repointed)
    console.log(`re-pointed ${k} -> ${canonical} (was -> ${alias})`);
  return 0;
}
function cmdAliasesRm(alias, opts) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const current = loadAliases(world.name);
  if (!Object.hasOwn(current, alias)) {
    console.log(`no alias ${alias} in world ${world.name}`);
    return 0;
  }
  const { [alias]: _removed, ...rest } = current;
  saveAliases(world.name, rest);
  console.log(`removed alias ${alias} in world ${world.name}`);
  return 0;
}
function cmdAliasesSuggest(opts) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const suggestions = suggestAliases(world.name);
  if (suggestions.length === 0) {
    console.log(`no alias suggestions for world ${world.name}`);
    return 0;
  }
  console.log(`possible near-duplicate patterns (same mechanism, different slug). Review each, then apply with the command shown:`);
  for (const s of suggestions) {
    console.log(`  ${s.alias} (${s.alias_count}) ~ ${s.canonical} (${s.canonical_count})  score=${s.score.toFixed(2)}`);
    console.log(`    sil aliases set ${s.alias} ${s.canonical} --world ${world.name}`);
  }
  return 0;
}

// apps/cli/src/commands/artifacts.ts
function cmdArtifacts(opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  if (opts.action === "rebuild") {
    if (!opts.world) {
      console.error("error: sil artifacts rebuild needs --world");
      return 2;
    }
    deps.feedback.rebuild(world, cfg);
    console.log(`rebuilt scorecards for world ${world.name}`);
    return 0;
  }
  const inventory = deps.review.inventory(world, cfg);
  const cards = deps.feedback.scorecards(world, cfg);
  if (opts.json) {
    console.log(JSON.stringify({ inventory, scorecards: cards }, null, 2));
    return 0;
  }
  if (inventory.length === 0) {
    console.log(`no artifacts for world ${world.name}`);
    return 0;
  }
  for (const row of inventory) {
    console.log(`${row.pattern.padEnd(30)} ${row.artifact_type.padEnd(6)} served_by=${row.served_by} status=${row.status}`);
  }
  return 0;
}

// apps/cli/src/commands/curriculum.ts
function cmdCurriculumPlan(opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const report = deps.curriculum.plan(world, cfg);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`world: ${report.world}  threshold: ${report.threshold}`);
  if (report.actions.length === 0) {
    console.log("  nothing to report");
    return 0;
  }
  for (const a of report.actions) {
    console.log(`  ${a.pattern.padEnd(30)} count=${String(a.count).padEnd(3)} watermark=${String(a.watermark).padEnd(3)} ` + `action=${a.action.padEnd(16)} ${a.reason}`);
  }
  return 0;
}
async function cmdCurriculumRun(opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const report = opts.apply ? await deps.worker.withLock(() => deps.curriculum.run(world, cfg, { apply: true })) : await deps.curriculum.run(world, cfg, { apply: false });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`world: ${report.world}  dry_run: ${report.dry_run}`);
  console.log(`staged: ${JSON.stringify(report.staged)}`);
  console.log(`merged: ${JSON.stringify(report.merged)}`);
  const gatedOut = Object.entries(report.gated_out);
  if (gatedOut.length > 0) {
    console.log("gated out:");
    for (const [pattern, reason] of gatedOut)
      console.log(`  ${pattern}: ${reason}`);
  }
  if (report.error)
    console.error(`error: ${report.error}`);
  return 0;
}

// apps/cli/src/commands/feedback.ts
function cmdFeedbackAdd(ref, vote, opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const fb = HumanFeedback.parse({ ts: nowIso(), world: world.name, ref, vote, note: opts.note || "" });
  deps.feedback.recordHuman(fb);
  console.log(`recorded ${vote} vote for ${ref} in world ${world.name}`);
  return 0;
}
function cmdFeedbackList(deps = defaultDeps) {
  const cfg = loadConfig();
  for (const w of cfg.worlds) {
    for (const e of deps.feedback.listHuman(w.name)) {
      console.log(`${e.ts}  ${w.name.padEnd(16)} ${e.ref.padEnd(30)} ${e.vote.padEnd(4)} ${e.note}`);
    }
  }
  return 0;
}

// apps/cli/src/commands/hookSnapshot.ts
function cmdHookSnapshot() {
  const cfg = loadConfig();
  const p = writeHookSnapshot(cfg);
  console.log(`wrote ${p}`);
  return 0;
}

// apps/cli/src/importer.ts
import { copyFileSync, existsSync as existsSync9, mkdirSync as mkdirSync6, readdirSync as readdirSync10, statSync as statSync9 } from "fs";
import { join as join17, relative as relative3 } from "path";
function walkMarkdownFiles(dir) {
  const out = [];
  const walk = (p) => {
    let entries;
    try {
      entries = readdirSync10(p).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join17(p, name);
      let st;
      try {
        st = statSync9(full);
      } catch {
        continue;
      }
      if (st.isDirectory())
        walk(full);
      else if (name.endsWith(".md"))
        out.push(full);
    }
  };
  walk(dir);
  return out;
}
function importReflections(dir, world) {
  const src = expandHome(dir);
  const dest = reflectionsDir(world);
  mkdirSync6(dest, { recursive: true });
  let copied = 0;
  let skippedDuplicate = 0;
  let skippedNonReflection = 0;
  for (const p of walkMarkdownFiles(src)) {
    const text = readTextOr(p, "");
    if (!reflectionPattern(text)) {
      skippedNonReflection++;
      continue;
    }
    const target = join17(dest, relative3(src, p));
    if (existsSync9(target)) {
      skippedDuplicate++;
      continue;
    }
    mkdirSync6(join17(target, ".."), { recursive: true });
    copyFileSync(p, target);
    copied++;
  }
  return { copied, skippedDuplicate, skippedNonReflection };
}
function importLedger(file, world) {
  const src = expandHome(file);
  const ledger = parseLedger(readText(src), src);
  saveLedger(ledgerPath(world), ledger);
  return Object.keys(ledger.entries).length;
}
var KbManifest = object({ worlds: array(World) });
function importKbWorlds(path) {
  const text = readText(expandHome(path));
  const raw = exports_dist.parse(text) ?? {};
  const mapped = (raw.worlds ?? []).map((w) => ({
    name: w.name,
    llm: w.llm ?? "cloud",
    repos: (w.projects ?? []).filter((p) => p.repo).map((p) => expandHome(p.repo)),
    target: null,
    layout: Layout.parse({})
  }));
  return KbManifest.parse({ worlds: mapped }).worlds;
}
function mergeWorlds(cfg, worlds) {
  const existing = new Set(cfg.worlds.map((w) => w.name));
  let added = 0;
  for (const w of worlds) {
    if (!existing.has(w.name)) {
      cfg.worlds.push(w);
      existing.add(w.name);
      added++;
    }
  }
  return added;
}

// apps/cli/src/commands/import.ts
function cmdImportReflections(dir, opts) {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  const result = importReflections(dir, world.name);
  console.log(`copied ${result.copied}, skipped ${result.skippedDuplicate} duplicate, ${result.skippedNonReflection} non-reflection`);
  return 0;
}
function cmdImportLedger(file, opts) {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  const count = importLedger(file, world);
  console.log(`imported ${count} ledger entries for world ${world.name}`);
  return 0;
}

// apps/cli/src/commands/init.ts
import { join as join18 } from "path";
var DEFAULT_LITELLM_MODEL = "deepseek/deepseek-flash";
function cmdInit(opts) {
  const cfgPath = configFile();
  let cfg;
  if (exists(cfgPath)) {
    cfg = loadConfig();
    console.log(`config.yaml already exists at ${cfgPath}, leaving it as is`);
  } else {
    const world = World.parse({
      name: opts.world || "default",
      target: opts.target ? expandHome(opts.target) : null
    });
    cfg = Config.parse({ worlds: [world] });
    saveConfig(cfg);
    console.log(`wrote ${cfgPath}`);
  }
  const llmPath = llmFile();
  if (exists(llmPath)) {
    console.log(`llm.yaml already exists at ${llmPath}, leaving it as is`);
  } else {
    const litellmModel = opts.model || DEFAULT_LITELLM_MODEL;
    const litellmModels = { critic: litellmModel, drafter: litellmModel, judge: litellmModel };
    const claudeModel = opts.claudeModel || "sonnet";
    const endpoints = [
      Endpoint.parse({
        name: "litellm",
        kind: "openai",
        base_url: opts.llmBaseUrl || "http://100.64.0.3:4000",
        api_key_env: opts.apiKeyEnv || "LITELLM_API_KEY",
        models: litellmModels
      }),
      Endpoint.parse({
        name: "claude",
        kind: "claude-cli",
        models: { critic: claudeModel, drafter: claudeModel, judge: claudeModel }
      })
    ];
    const llm = LlmConfig.parse({ endpoints, active: "litellm" });
    saveLlm(llm);
    console.log(`wrote ${llmPath}`);
  }
  for (const world of cfg.worlds) {
    if (world.target === null)
      ensureRepo(targetRoot(world));
    ensureDir(reflectionsDir(world.name));
    ensureDir(inboxDir(world.name));
  }
  for (const bucket of ["pending", "done", "failed"])
    ensureDir(queueDir(bucket));
  for (const sub of ["logs", "sessions", "usage", "feedback"])
    ensureDir(join18(stateDir(), sub));
  const snap = writeHookSnapshot(cfg);
  console.log(`wrote hook snapshot at ${snap}`);
  console.log();
  console.log("Next steps:");
  console.log("  sil status                              check worker and provider status");
  console.log("  sil llm list                            show endpoints and which one serves each role");
  console.log("  sil llm use claude                      send every role to `claude -p`");
  console.log("  sil llm use litellm --role drafter      send one role back to LiteLLM");
  console.log("  sil web                                 open the review UI");
  console.log("  sil schedule install --systemd --web    run the worker and web UI on a schedule");
  return 0;
}

// apps/cli/src/commands/lessons.ts
function cmdLessons(opts) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const items = listLessons(world.name);
  if (items.length === 0) {
    console.log(`no pending lessons for world ${world.name}`);
    return 0;
  }
  for (const lesson of items) {
    console.log(`${lesson.id}  ${lesson.pattern}`);
    console.log(`  ${lesson.text}`);
  }
  return 0;
}

// apps/cli/src/commands/llm.ts
function requireRole2(value) {
  if (ROLES.includes(value))
    return value;
  throw new ConfigError(`unknown role ${JSON.stringify(value)}; roles are ${ROLES.join(", ")}`);
}
function roleRows(llm) {
  return ROLES.map((role) => {
    try {
      const resolved = resolveRole(llm, role);
      return { role, endpoint: resolved.endpoint.name, model: resolved.model, error: null };
    } catch (e) {
      let endpoint = null;
      try {
        endpoint = endpointFor(llm, role).name;
      } catch {}
      return { role, endpoint, model: null, error: e.message };
    }
  });
}
function printRoles(llm) {
  for (const row of roleRows(llm)) {
    const target = row.error ? row.error : `${row.endpoint}: ${row.model}`;
    console.log(`${row.role.padEnd(7)} -> ${target}`);
  }
}
function addressOf(kind, baseUrl) {
  if (kind === "claude-cli")
    return "claude -p";
  return baseUrl ?? "(no base_url)";
}
async function cmdLlmList(opts, deps = defaultDeps) {
  const llm = loadLlm();
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const status = await deps.providers.status(world, llm);
  const rows = roleRows(llm);
  if (opts.json) {
    console.log(JSON.stringify({ active: llm.active, endpoints: status.endpoints, roles: rows }, null, 2));
    return 0;
  }
  console.log(`${"endpoint".padEnd(18)} ${"kind".padEnd(11)} ${"address".padEnd(30)} reachable`);
  for (const ep of status.endpoints) {
    const name = ep.active ? `${ep.name} *` : ep.name;
    const reach = ep.error ? `${ep.reachable} (${ep.error})` : String(ep.reachable);
    console.log(`${name.padEnd(18)} ${ep.kind.padEnd(11)} ${addressOf(ep.kind, ep.base_url).padEnd(30)} ${reach}`);
  }
  if (status.endpoints.length === 0)
    console.log("(llm.yaml defines no endpoints; run `sil init`)");
  console.log();
  for (const row of rows) {
    console.log(`${row.role.padEnd(7)} -> ${row.error ? row.error : `${row.endpoint}: ${row.model}`}`);
  }
  return 0;
}
function cmdLlmUse(name, opts) {
  const role = opts.role === undefined ? undefined : requireRole2(opts.role);
  const llm = useEndpoint(loadLlm(), name, role);
  saveLlm(llm);
  writeHookSnapshot();
  if (role)
    console.log(`role_endpoints.${role} = ${name}`);
  else
    console.log(`active = ${name} (per role overrides cleared)`);
  printRoles(llm);
  return 0;
}
function cmdLlmSetModel(roleArg, model, opts) {
  const role = requireRole2(roleArg);
  const llm = loadLlm();
  const name = opts.endpoint ?? endpointFor(llm, role).name;
  const endpoint = llm.endpoints.find((e) => e.name === name);
  if (!endpoint) {
    const known = llm.endpoints.map((e) => e.name).join(", ") || "none";
    throw new ConfigError(`unknown endpoint ${JSON.stringify(name)}; llm.yaml defines ${known}`);
  }
  endpoint.models = { ...endpoint.models, [role]: model };
  saveLlm(llm);
  console.log(`endpoints[${name}].models.${role} = ${model}`);
  return 0;
}

// apps/cli/src/commands/logs.ts
import { existsSync as existsSync10 } from "fs";
function cmdLogs(name, opts) {
  if (!LOG_NAMES.includes(name)) {
    console.error(`error: unknown log ${JSON.stringify(name)}, choose from ${LOG_NAMES.join(", ")}`);
    return 2;
  }
  const p = logFile(name);
  if (!existsSync10(p)) {
    console.log(`no log file at ${p}`);
    return 0;
  }
  const text = readText(p).replace(/\n$/, "");
  const lines = text === "" ? [] : text.split(`
`);
  const n = opts.lines ?? 50;
  for (const line of lines.slice(-n))
    console.log(line);
  return 0;
}

// apps/cli/src/commands/reflect.ts
import { realpathSync as realpathSync3 } from "fs";
import { resolve as resolve7 } from "path";
function realOrResolve2(p) {
  const abs = resolve7(p);
  try {
    return realpathSync3(abs);
  } catch {
    return abs;
  }
}
function findPendingEntry(opts) {
  if (opts.session) {
    const bySession = loadEntry("pending", opts.session);
    if (bySession)
      return bySession;
  }
  if (!opts.cwd)
    return null;
  const cwd = realOrResolve2(opts.cwd);
  let best = null;
  for (const e of listQueue("pending")) {
    if (e.cwd !== cwd || e.ended)
      continue;
    if (!best || e.last_stop > best.last_stop)
      best = e;
  }
  return best;
}
async function cmdReflect(opts, deps = defaultDeps) {
  if (!opts.session && !opts.cwd) {
    console.error("error: sil reflect needs --session or --cwd");
    return 2;
  }
  const entry = findPendingEntry(opts);
  if (!entry) {
    console.error("no matching pending queue entry found");
    return 2;
  }
  entry.ended = true;
  writeEntry("pending", entry);
  console.log(`marked ${entry.session_id} ended`);
  if (opts.now) {
    const cfg = loadConfig();
    const result = await deps.worker.runOnce(cfg, { worldName: entry.world, reflect: true, curriculum: false });
    console.log(`worker ran: ${JSON.stringify(result)}`);
  }
  return 0;
}

// apps/cli/src/commands/reflections.ts
function cmdReflectionsList(opts) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  let items = listReflections(world.name);
  if (opts.pattern)
    items = items.filter((r) => r.pattern === opts.pattern);
  if (opts.limit)
    items = items.slice(0, opts.limit);
  if (items.length === 0) {
    console.log(`no reflections for world ${world.name}`);
    return 0;
  }
  for (const r of items)
    console.log(`${r.id.padEnd(40)} ${r.pattern.padEnd(24)} ${r.created}`);
  return 0;
}
function cmdReflectionsShow(id, opts) {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  const match = listReflections(world.name).find((r) => r.id === id);
  if (!match) {
    console.error(`no reflection ${JSON.stringify(id)} in world ${world.name}`);
    return 2;
  }
  console.log(match.body);
  return 0;
}

// apps/cli/src/commands/review.ts
function cmdReviewList(opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const items = deps.review.queue(world, cfg);
  if (items.length === 0) {
    console.log(`no staged reviews for world ${world.name}`);
    return 0;
  }
  for (const it of items) {
    console.log(`${it.pattern.padEnd(30)} ${it.artifact_type.padEnd(6)} count=${String(it.count).padEnd(3)} branch=${it.branch}`);
  }
  return 0;
}
function cmdReviewShow(pattern, opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  if (opts.diff) {
    const d = deps.review.diff(world, cfg, pattern);
    console.log(d.diff);
    console.log(`
reviewed_state: ${d.reviewed_state}`);
    return 0;
  }
  const detail = deps.review.detail(world, cfg, pattern);
  console.log(`pattern: ${detail.pattern}`);
  console.log(`type: ${detail.artifact_type}  path: ${detail.artifact_path}`);
  console.log(`branch: ${detail.branch}  count: ${detail.count}`);
  console.log(`reviewed_state: ${detail.reviewed_state}`);
  if (detail.accept_blocked)
    console.log(`accept blocked: ${detail.accept_blocked}`);
  console.log();
  console.log(detail.body);
  return 0;
}
function cmdReviewAccept(pattern, opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  deps.review.accept(world, cfg, pattern, opts.reviewedState);
  console.log(`accepted ${pattern} in world ${world.name}`);
  return 0;
}
function cmdReviewReject(pattern, opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  deps.review.reject(world, cfg, pattern);
  console.log(`rejected ${pattern} in world ${world.name}`);
  return 0;
}
function cmdReviewRehome(pattern, opts, deps = defaultDeps) {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  deps.review.rehome(world, cfg, pattern, opts.type);
  console.log(`rehomed ${pattern} to ${opts.type} in world ${world.name}`);
  return 0;
}
function cmdReviewRetire(pattern, opts, deps = defaultDeps) {
  if (!opts.yes) {
    console.error("error: sil review retire needs --yes to confirm");
    return 2;
  }
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  deps.review.retire(world, cfg, pattern);
  console.log(`retired ${pattern} in world ${world.name}`);
  return 0;
}

// apps/cli/src/schedule.ts
import { chmodSync, copyFileSync as copyFileSync2, existsSync as existsSync11, mkdirSync as mkdirSync7, readdirSync as readdirSync11, rmSync as rmSync5, writeFileSync as writeFileSync6 } from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname7, join as join19 } from "path";
var SYSTEMD_WORKER_UNITS = ["sil-worker.service", "sil-worker.timer"];
var SYSTEMD_WEB_UNIT = "sil-web.service";
var LAUNCHD_WORKER_PLIST = "com.raqz.sil-worker.plist";
var LAUNCHD_WEB_PLIST = "com.raqz.sil-web.plist";
var LEGACY_LAUNCHD_PLISTS = ["com.kolezka.sil-worker.plist", "com.kolezka.sil-web.plist"];
var LAUNCHD_PREFIXES = ["com.raqz.sil-", "com.kolezka.sil-"];
var realRunner = (cmd) => {
  try {
    Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {}
};
function home() {
  return process.env["HOME"] || homedir2();
}
function shimPath() {
  return join19(home(), ".local", "bin", "sil");
}
function systemdDir() {
  return join19(home(), ".config", "systemd", "user");
}
function launchdDir() {
  return join19(home(), "Library", "LaunchAgents");
}
function renderSystemd(intervalMin, web) {
  const shim = shimPath();
  const units = {
    "sil-worker.service": [
      "[Unit]",
      "Description=self-improvement-loop worker, one pass",
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=${shim} worker --once`,
      ""
    ].join(`
`),
    "sil-worker.timer": [
      "[Unit]",
      "Description=self-improvement-loop worker schedule",
      "",
      "[Timer]",
      "OnBootSec=5min",
      `OnUnitActiveSec=${intervalMin}min`,
      "",
      "[Install]",
      "WantedBy=timers.target",
      ""
    ].join(`
`)
  };
  if (web) {
    units[SYSTEMD_WEB_UNIT] = [
      "[Unit]",
      "Description=self-improvement-loop web UI",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${shim} web`,
      "Restart=always",
      "RestartSec=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      ""
    ].join(`
`);
  }
  return units;
}
function renderLaunchd(intervalMin, web) {
  const shim = shimPath();
  const intervalS = intervalMin * 60;
  const units = {
    [LAUNCHD_WORKER_PLIST]: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>com.raqz.sil-worker</string>",
      "  <key>ProgramArguments</key><array>",
      `    <string>${shim}</string>`,
      "    <string>worker</string>",
      "    <string>--once</string>",
      "  </array>",
      `  <key>StartInterval</key><integer>${intervalS}</integer>`,
      "  <key>RunAtLoad</key><true/>",
      "</dict></plist>",
      ""
    ].join(`
`)
  };
  if (web) {
    units[LAUNCHD_WEB_PLIST] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>com.raqz.sil-web</string>",
      "  <key>ProgramArguments</key><array>",
      `    <string>${shim}</string>`,
      "    <string>web</string>",
      "  </array>",
      "  <key>KeepAlive</key><true/>",
      "  <key>RunAtLoad</key><true/>",
      "</dict></plist>",
      ""
    ].join(`
`);
  }
  return units;
}
function installShim() {
  const dest = shimPath();
  mkdirSync7(dirname7(dest), { recursive: true });
  const src = join19(pluginRoot(), "scripts", "sil");
  copyFileSync2(src, dest);
  chmodSync(dest, 493);
  return dest;
}
function install(kind, intervalMin = 60, web = false, run = realRunner) {
  installShim();
  if (kind === "systemd") {
    const d = systemdDir();
    mkdirSync7(d, { recursive: true });
    const written = [];
    for (const [name, content] of Object.entries(renderSystemd(intervalMin, web))) {
      const p = join19(d, name);
      writeFileSync6(p, content, "utf8");
      written.push(p);
    }
    run(["systemctl", "--user", "daemon-reload"]);
    run(["systemctl", "--user", "enable", "--now", "sil-worker.timer"]);
    if (web)
      run(["systemctl", "--user", "enable", "--now", SYSTEMD_WEB_UNIT]);
    return written;
  }
  if (kind === "launchd") {
    const d = launchdDir();
    mkdirSync7(d, { recursive: true });
    const written = [];
    for (const [name, content] of Object.entries(renderLaunchd(intervalMin, web))) {
      const p = join19(d, name);
      writeFileSync6(p, content, "utf8");
      written.push(p);
      run(["launchctl", "load", p]);
    }
    return written;
  }
  throw new Error(`unknown schedule kind: ${JSON.stringify(kind)}, use systemd or launchd`);
}
function uninstall(kind, run = realRunner) {
  if (kind === "systemd") {
    const d = systemdDir();
    run(["systemctl", "--user", "disable", "--now", "sil-worker.timer"]);
    run(["systemctl", "--user", "disable", "--now", SYSTEMD_WEB_UNIT]);
    const removed = [];
    for (const name of [...SYSTEMD_WORKER_UNITS, SYSTEMD_WEB_UNIT]) {
      const p = join19(d, name);
      if (existsSync11(p)) {
        rmSync5(p);
        removed.push(p);
      }
    }
    run(["systemctl", "--user", "daemon-reload"]);
    return removed;
  }
  if (kind === "launchd") {
    const d = launchdDir();
    const removed = [];
    for (const name of [LAUNCHD_WORKER_PLIST, LAUNCHD_WEB_PLIST, ...LEGACY_LAUNCHD_PLISTS]) {
      const p = join19(d, name);
      if (existsSync11(p)) {
        run(["launchctl", "unload", p]);
        rmSync5(p);
        removed.push(p);
      }
    }
    return removed;
  }
  throw new Error(`unknown schedule kind: ${JSON.stringify(kind)}, use systemd or launchd`);
}
function show2() {
  const d = systemdDir();
  const systemd = existsSync11(d) ? readdirSync11(d).filter((n) => n.startsWith("sil-")).sort() : [];
  const ld = launchdDir();
  const launchd = existsSync11(ld) ? readdirSync11(ld).filter((n) => LAUNCHD_PREFIXES.some((pre) => n.startsWith(pre)) && n.endsWith(".plist")).sort() : [];
  return { systemd, launchd };
}

// apps/cli/src/commands/schedule.ts
function cmdScheduleInstall(opts) {
  if (!opts.systemd && !opts.launchd) {
    console.error("error: sil schedule install needs --systemd or --launchd");
    return 2;
  }
  if (opts.systemd && opts.launchd) {
    console.error("error: sil schedule install takes only one of --systemd or --launchd");
    return 2;
  }
  const kind = opts.systemd ? "systemd" : "launchd";
  const written = install(kind, opts.intervalMin ?? 60, opts.web ?? false);
  for (const p of written)
    console.log(`wrote ${p}`);
  return 0;
}
function cmdScheduleUninstall() {
  const removed = [...uninstall("systemd"), ...uninstall("launchd")];
  if (removed.length === 0) {
    console.log("nothing installed");
    return 0;
  }
  for (const p of removed)
    console.log(`removed ${p}`);
  return 0;
}
function cmdScheduleShow() {
  const info = show2();
  for (const [kind, names] of Object.entries(info)) {
    console.log(`${kind}:`);
    if (names.length === 0)
      console.log("  (none installed)");
    for (const name of names)
      console.log(`  ${name}`);
  }
  return 0;
}

// apps/cli/src/commands/status.ts
async function cmdStatus(opts, deps = defaultDeps) {
  const cfg = loadConfig();
  let workerStatus = {};
  try {
    workerStatus = deps.worker.status();
  } catch {}
  const queueCounts = { pending: 0, done: 0, failed: 0 };
  for (const bucket of ["pending", "done", "failed"]) {
    try {
      queueCounts[bucket] = listQueue(bucket).length;
    } catch {}
  }
  const worldsInfo = [];
  for (const w of cfg.worlds) {
    const info = {
      world: w.name,
      llm: w.llm,
      reflections: 0,
      staged: 0,
      artifacts: 0,
      provider: { endpoint: null, reachable: null, error: "unknown" }
    };
    try {
      info.reflections = listReflections(w.name).length;
    } catch {}
    try {
      info.staged = deps.review.queue(w, cfg).length;
      info.artifacts = deps.review.inventory(w, cfg).length;
    } catch {}
    try {
      info.provider = await deps.providers.status(w);
    } catch (e) {
      info.provider = { endpoint: null, reachable: null, error: e.message };
    }
    worldsInfo.push(info);
  }
  const payload = { worker: workerStatus, queue: queueCounts, worlds: worldsInfo };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const workerLine = Object.keys(workerStatus).length > 0 ? JSON.stringify(workerStatus) : "(worker module not available)";
  console.log(`worker: ${workerLine}`);
  console.log(`queue: pending=${queueCounts.pending} done=${queueCounts.done} failed=${queueCounts.failed}`);
  console.log();
  console.log(`${"world".padEnd(16)} ${"llm".padEnd(6)} ${"reflections".padStart(11)} ${"staged".padStart(7)} ${"artifacts".padStart(9)}  provider`);
  for (const info of worldsInfo) {
    const prov = info.provider;
    const provStr = prov.error ? `${prov.endpoint ?? "?"} error: ${prov.error}` : `${prov.endpoint} reachable=${prov.reachable}`;
    console.log(`${info.world.padEnd(16)} ${info.llm.padEnd(6)} ${String(info.reflections).padStart(11)} ` + `${String(info.staged).padStart(7)} ${String(info.artifacts).padStart(9)}  ${provStr}`);
  }
  return 0;
}

// apps/server/src/main.ts
import { networkInterfaces } from "os";

// apps/server/src/guard.ts
import { timingSafeEqual } from "crypto";
var LOCAL_HEADER = "X-SIL-Local";
var TOKEN_HEADER = "X-SIL-Token";
function allowedHosts(port, extra = []) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const env = process.env["SIL_WEB_ALLOWED_HOSTS"] ?? "";
  for (const raw of [...env.split(","), ...extra]) {
    const host = raw.trim();
    if (host)
      hosts.add(host);
  }
  return hosts;
}
function splitHostPort(value) {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1)
      return null;
    const rest = value.slice(end + 1);
    if (rest !== "" && !rest.startsWith(":"))
      return null;
    return { hostname: value.slice(1, end), port: rest.slice(1) };
  }
  const colon = value.indexOf(":");
  if (colon === -1)
    return { hostname: value, port: "" };
  if (value.indexOf(":", colon + 1) !== -1)
    return null;
  return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
}
function ipv4Private(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m)
    return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255))
    return false;
  const [a, b] = parts;
  if (a === 127 || a === 10)
    return true;
  if (a === 172 && b >= 16 && b <= 31)
    return true;
  if (a === 192 && b === 168)
    return true;
  if (a === 169 && b === 254)
    return true;
  if (a === 100 && b >= 64 && b <= 127)
    return true;
  return false;
}
function isPrivateAddress(hostname) {
  const v4 = ipv4Private(hostname);
  if (v4 !== null)
    return v4;
  const v6 = hostname.toLowerCase().split("%")[0];
  if (!v6.includes(":"))
    return false;
  if (!/^[0-9a-f:.]+$/.test(v6))
    return false;
  if (v6 === "::1")
    return true;
  if (v6.startsWith("::ffff:"))
    return ipv4Private(v6.slice(7)) === true;
  const head = Number.parseInt(v6.split(":")[0] || "0", 16);
  if (Number.isNaN(head))
    return false;
  if ((head & 65024) === 64512)
    return true;
  if ((head & 65472) === 65152)
    return true;
  return false;
}
function safeEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
function hostAllowed(host, opts) {
  if (allowedHosts(opts.port, opts.allowedHosts ?? []).has(host))
    return true;
  const parts = splitHostPort(host);
  if (!parts || parts.port !== String(opts.port))
    return false;
  return isPrivateAddress(parts.hostname);
}
function jsonError(status, detail) {
  return new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json" } });
}
function guard(request, opts) {
  const host = request.headers.get("host") ?? "";
  if (!hostAllowed(host, opts)) {
    return jsonError(403, "bad Host header");
  }
  if (request.headers.get(LOCAL_HEADER) !== "1") {
    return jsonError(401, `missing ${LOCAL_HEADER}: 1`);
  }
  if (opts.token !== null) {
    const supplied = request.headers.get(TOKEN_HEADER) ?? "";
    if (!safeEqual(supplied, opts.token)) {
      return jsonError(401, `bad or missing ${TOKEN_HEADER}`);
    }
  }
  return null;
}

// packages/ops/src/args.ts
var REVIEWED_STATE_RE = /^[0-9a-f]{64}$/;
var WORLD_RE = WORLD_NAME_RE;
var SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
var NoArgs = object({});
var WorldArgs = object({ world: string2().regex(WORLD_RE).max(64) });
var PatternArgs = WorldArgs.extend({ pattern: slug });
var AcceptArgs = PatternArgs.extend({ reviewed_state: string2().regex(REVIEWED_STATE_RE) });
var RehomeArgs = PatternArgs.extend({ artifact_type: _enum(["skill", "hook", "rule", "agent", "none"]) });
var RetireArgs = PatternArgs.extend({ confirm: literal(true) });
var SessionArgs = object({ session_id: string2().regex(SESSION_ID_RE) });
var FeedbackArgs = object({
  world: string2().min(1),
  ref: string2().regex(ARTIFACT_REF_RE),
  vote: _enum(["good", "bad"]),
  note: string2().default("")
});
var LogArgs = object({
  name: _enum(LOG_NAMES),
  lines: exports_coerce.number().int().min(1).max(2000).default(200)
});
var LlmArgs = object({ llm: record(string2(), unknown()) });
var LlmUseArgs = object({ endpoint: string2().min(1).max(64), role: _enum(ROLES).optional() });
var ConfigArgs = object({ config: record(string2(), unknown()) });
var AliasArgs = object({
  world: string2().min(1),
  aliases: record(string2(), string2()).refine((m) => Object.entries(m).every(([k, v]) => SLUG_RE.test(k) && SLUG_RE.test(v)), { message: "alias entries must be slugs" })
});
var ReflectionArgs = WorldArgs.extend({ id: string2().regex(SLUG_RE).max(128) });
var ReflectionListArgs = WorldArgs.extend({
  pattern: string2().regex(SLUG_RE).max(64).optional(),
  limit: exports_coerce.number().int().min(1).max(2000).default(200)
});

// packages/ops/src/handlers/aliases.ts
function aliasesGet(args) {
  return loadAliases(args.world);
}
function aliasesSet(args) {
  saveAliases(args.world, args.aliases);
  return loadAliases(args.world);
}
function aliasesSuggest(args) {
  return suggestAliases(args.world);
}

// packages/ops/src/cfg-world.ts
function cfgWorld(name) {
  const cfg = loadConfig();
  return [cfg, worldNamed(cfg, name)];
}

// packages/ops/src/deps.ts
import { spawn as nodeSpawn } from "child_process";
var deps = {
  worker: exports_src5,
  feedback: exports_src3,
  providers: exports_src2,
  review: exports_src6,
  curriculum: exports_src4,
  spawn: nodeSpawn
};

// packages/ops/src/handlers/artifacts.ts
function artifactsScorecards(args) {
  const [, world] = cfgWorld(args.world);
  return deps.feedback.load(world);
}
function artifactsRebuild(args) {
  const [cfg, world] = cfgWorld(args.world);
  const path = deps.feedback.rebuild(world, cfg);
  return { world: args.world, path };
}
function feedbackAdd(args) {
  const hf = HumanFeedback.parse({
    ts: nowIso(),
    world: args.world,
    ref: args.ref,
    vote: args.vote,
    note: args.note
  });
  const path = deps.feedback.recordHuman(hf);
  return { path, feedback: hf };
}
function lessonsList(args) {
  return listLessons(args.world);
}

// packages/ops/src/spawn.ts
import { closeSync as closeSync2, existsSync as existsSync12, openSync as openSync2 } from "fs";
import { dirname as dirname8, join as join20 } from "path";
function cliCommand(args) {
  const root = pluginRoot();
  const distCli = join20(root, "dist", "cli.js");
  if (existsSync12(distCli))
    return ["bun", distCli, ...args];
  return ["bun", "run", join20(root, "apps", "cli", "src", "main.ts"), ...args];
}
function spawnCli(args, logName) {
  const logPath = logFile(logName);
  ensureDir(dirname8(logPath));
  const fd = openSync2(logPath, "a");
  const [bin, ...rest] = cliCommand(args);
  try {
    const child = deps.spawn(bin, rest, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    if (child.pid === undefined)
      throw new Error(`failed to spawn: ${bin}`);
    return { pid: child.pid, log: logPath };
  } finally {
    closeSync2(fd);
  }
}

// packages/ops/src/handlers/curriculum.ts
function curriculumPlan(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.curriculum.plan(world, cfg);
}
function curriculumRun(args) {
  const [, world] = cfgWorld(args.world);
  return spawnCli(["curriculum", "run", "--apply", "--world", world.name], "curriculum");
}

// packages/ops/src/handlers/health.ts
import { readFileSync as readFileSync4, statSync as statSync10 } from "fs";
import { join as join21 } from "path";
var SIL_VERSION = "0.2.7";
function buildInfo(_args) {
  const path = join21(pluginRoot(), "dist", ".srchash");
  let build = null;
  let builtAt = null;
  try {
    build = readFileSync4(path, "utf8").trim() || null;
    builtAt = statSync10(path).mtime.toISOString();
  } catch {}
  const startedMs = Date.now() - process.uptime() * 1000;
  return {
    build,
    built_at: builtAt,
    server_started: new Date(startedMs).toISOString(),
    server_stale: builtAt !== null && Date.parse(builtAt) > startedMs,
    plugin_root: pluginRoot(),
    version: SIL_VERSION
  };
}
async function healthReport(_args) {
  const cfg = loadConfig();
  const providersStatus = {};
  for (const w of cfg.worlds) {
    try {
      providersStatus[w.name] = await deps.providers.status(w);
    } catch (e) {
      const err = e;
      providersStatus[w.name] = { error: `${err.name}: ${err.message}` };
    }
  }
  let workerStatus;
  try {
    workerStatus = deps.worker.status();
  } catch (e) {
    const err = e;
    workerStatus = { error: `${err.name}: ${err.message}` };
  }
  return {
    worlds: cfg.worlds.map((w) => w.name),
    config_file: configFile(),
    llm_file: llmFile(),
    state_dir: stateDir(),
    data_dir: dataDir(),
    plugin_root: pluginRoot(),
    providers: providersStatus,
    worker: workerStatus,
    versions: { sil: SIL_VERSION }
  };
}

// packages/ops/src/handlers/llm.ts
function llmGet(_args) {
  return loadLlm();
}
function llmSet(args) {
  const llm = LlmConfig.parse(args.llm);
  saveLlm(llm);
  return llm;
}
function llmUse(args) {
  const llm = useEndpoint(loadLlm(), args.endpoint, args.role);
  saveLlm(llm);
  writeHookSnapshot();
  return llm;
}
async function llmStatus(args) {
  const [, world] = cfgWorld(args.world);
  return deps.providers.status(world);
}

// packages/ops/src/handlers/logs.ts
import { closeSync as closeSync3, existsSync as existsSync13, openSync as openSync3, readSync, statSync as statSync11 } from "fs";
var TAIL_BLOCK_SIZE = 64 * 1024;
var REAL_TAIL_IO = { existsSync: existsSync13, openSync: openSync3, readSync, closeSync: closeSync3, statSync: statSync11 };
function tailLines(path, n, io = REAL_TAIL_IO, knownSize) {
  if (knownSize === undefined && !io.existsSync(path))
    return [];
  const fd = io.openSync(path, "r");
  let data;
  try {
    const fileSize = knownSize ?? io.statSync(path).size;
    let pos = fileSize;
    const chunks = [];
    let newlineCount = 0;
    while (pos > 0 && newlineCount <= n) {
      const readSize = Math.min(TAIL_BLOCK_SIZE, pos);
      pos -= readSize;
      const block = Buffer.alloc(readSize);
      io.readSync(fd, block, 0, readSize, pos);
      for (const byte of block)
        if (byte === 10)
          newlineCount++;
      chunks.unshift(block);
    }
    data = Buffer.concat(chunks);
  } finally {
    io.closeSync(fd);
  }
  const text = data.toString("utf8");
  const lines = text.split(`
`);
  if (lines.length > 0 && lines[lines.length - 1] === "")
    lines.pop();
  return lines.slice(-n);
}
function logsTail(args) {
  const path = logFile(args.name);
  let size = 0;
  let exists = true;
  try {
    size = statSync11(path).size;
  } catch {
    exists = false;
  }
  return { name: args.name, path, exists, size, lines: exists ? tailLines(path, args.lines, REAL_TAIL_IO, size) : [] };
}

// packages/ops/src/handlers/queue.ts
var QUEUE_LIST_CAP = 200;
function capped(bucket) {
  const entries = [...listQueue(bucket)].sort((a, b) => a.last_stop < b.last_stop ? 1 : a.last_stop > b.last_stop ? -1 : 0);
  return entries.slice(0, QUEUE_LIST_CAP);
}
function queueList(_args) {
  return { pending: capped("pending"), done: capped("done"), failed: capped("failed") };
}
function queueSkip(args) {
  return { session_id: args.session_id, skipped: deps.worker.skipSession(args.session_id) };
}
function workerStatus(_args) {
  return deps.worker.status();
}
function loopRun(args) {
  const [, world] = cfgWorld(args.world);
  return spawnCli(["worker", "--once", "--world", world.name], "worker");
}

// packages/ops/src/handlers/reflections.ts
import { join as join22 } from "path";
function reflectionsList(args) {
  let refs = listReflections(args.world);
  if (args.pattern)
    refs = refs.filter((r) => r.pattern === args.pattern);
  if (args.limit)
    refs = refs.slice(0, args.limit);
  return refs.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    created: r.created,
    lesson: r.lesson,
    artifacts_used: r.artifacts_used,
    artifacts_helpful: r.artifacts_helpful,
    artifacts_misfired: r.artifacts_misfired
  }));
}
function reflectionsGet(args) {
  const path = join22(reflectionsDir(args.world), `${args.id}.md`);
  const r = parseReflection(path, args.world);
  if (r === null)
    throw new ValidationError(`no reflection ${JSON.stringify(args.id)} in world ${JSON.stringify(args.world)}`);
  return r;
}

// packages/ops/src/handlers/review.ts
function reviewQueue(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.queue(world, cfg);
}
function reviewDetail(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.detail(world, cfg, args.pattern);
}
function reviewDiff(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.diff(world, cfg, args.pattern);
}
function skillAccept(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.accept(world, cfg, args.pattern, args.reviewed_state);
}
function skillReject(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.reject(world, cfg, args.pattern);
}
function routerRehome(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.rehome(world, cfg, args.pattern, args.artifact_type);
}
function routerRetire(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.retire(world, cfg, args.pattern);
}
function routerInventory(args) {
  const [cfg, world] = cfgWorld(args.world);
  return deps.review.inventory(world, cfg);
}

// packages/ops/src/handlers/worlds.ts
function worldsList(_args) {
  return loadConfig().worlds;
}
function configGet(_args) {
  return loadConfig();
}
function configSet(args) {
  const cfg = Config.parse(args.config);
  saveConfig(cfg);
  writeHookSnapshot(cfg);
  return cfg;
}

// packages/ops/src/registry.ts
var REGISTRY = new Map;
function register(op) {
  if (REGISTRY.has(op.name))
    throw new Error(`duplicate op name: ${JSON.stringify(op.name)}`);
  if (op.tier === "remote" && op.gate === "none") {
    throw new Error(`${op.name}: a remote op must declare a gate other than none`);
  }
  if ((op.name.includes("accept") || op.name.includes("push")) && op.tier !== "remote") {
    throw new Error(`${op.name}: name implies a remote write; must be tier remote`);
  }
  REGISTRY.set(op.name, op);
  return op;
}
async function invoke(name, payload) {
  const op = REGISTRY.get(name);
  if (!op)
    throw new ValidationError(`unknown op: ${JSON.stringify(name)}`);
  const args = op.args.parse(payload ?? {});
  return await op.fn(args);
}
function listOps() {
  return [...REGISTRY.values()].map((op) => ({ name: op.name, tier: op.tier, gate: op.gate, doc: op.doc })).sort((a, b) => a.name < b.name ? -1 : 1);
}
function opPath(name) {
  return "/api/" + name.replace(/\./g, "/");
}

// packages/ops/src/index.ts
register({ name: "health.report", tier: "read", gate: "none", args: NoArgs, fn: healthReport, doc: "Config paths, per-world provider status, worker status, versions." });
register({ name: "health.build", tier: "read", gate: "none", args: NoArgs, fn: buildInfo, doc: "Build hash on disk, and whether the running server predates it." });
register({ name: "worlds.list", tier: "read", gate: "none", args: NoArgs, fn: worldsList, doc: "List configured worlds." });
register({ name: "config.get", tier: "read", gate: "none", args: NoArgs, fn: configGet, doc: "Read config.yaml." });
register({ name: "config.set", tier: "local", gate: "none", args: ConfigArgs, fn: configSet, doc: "Validate and write config.yaml; refresh the hook snapshot." });
register({ name: "llm.get", tier: "read", gate: "none", args: NoArgs, fn: llmGet, doc: "Read llm.yaml. Never includes secret values, only env var names." });
register({ name: "llm.set", tier: "local", gate: "none", args: LlmArgs, fn: llmSet, doc: "Validate and write llm.yaml." });
register({ name: "llm.status", tier: "read", gate: "none", args: WorldArgs, fn: llmStatus, doc: "Provider reachability for a world, per endpoint." });
register({ name: "llm.use", tier: "local", gate: "none", args: LlmUseArgs, fn: llmUse, doc: "Switch the active endpoint, or route one role to an endpoint." });
register({ name: "queue.list", tier: "read", gate: "none", args: NoArgs, fn: queueList, doc: "Pending, done and failed queue entries." });
register({ name: "queue.skip", tier: "local", gate: "none", args: SessionArgs, fn: queueSkip, doc: "Skip a pending session." });
register({ name: "worker.status", tier: "read", gate: "none", args: NoArgs, fn: workerStatus, doc: "Worker lock/last-run status." });
register({ name: "loop.run", tier: "local", gate: "none", args: WorldArgs, fn: loopRun, doc: "Spawn a detached worker --once run." });
register({ name: "curriculum.plan", tier: "read", gate: "none", args: WorldArgs, fn: curriculumPlan, doc: "Dry-run curriculum plan for a world." });
register({ name: "curriculum.run", tier: "local", gate: "none", args: WorldArgs, fn: curriculumRun, doc: "Spawn a detached curriculum run --apply for a world." });
register({ name: "reflections.list", tier: "read", gate: "none", args: ReflectionListArgs, fn: reflectionsList, doc: "List reflections, newest first, filterable by pattern." });
register({ name: "reflections.get", tier: "read", gate: "none", args: ReflectionArgs, fn: reflectionsGet, doc: "Full body of one reflection." });
register({ name: "aliases.get", tier: "read", gate: "none", args: WorldArgs, fn: aliasesGet, doc: "Pattern alias map for a world." });
register({ name: "aliases.set", tier: "local", gate: "none", args: AliasArgs, fn: aliasesSet, doc: "Replace the alias map for a world." });
register({ name: "aliases.suggest", tier: "read", gate: "none", args: WorldArgs, fn: aliasesSuggest, doc: "Deterministic near-duplicate pattern slug suggestions for a world." });
register({ name: "review.queue", tier: "read", gate: "none", args: WorldArgs, fn: reviewQueue, doc: "Staged proposals waiting for review." });
register({ name: "review.detail", tier: "read", gate: "none", args: PatternArgs, fn: reviewDetail, doc: "Body and reviewed_state of one proposal." });
register({ name: "review.diff", tier: "read", gate: "none", args: PatternArgs, fn: reviewDiff, doc: "Diff of one staged proposal." });
register({ name: "skill.accept", tier: "remote", gate: "reviewed_state", args: AcceptArgs, fn: skillAccept, doc: "Accept a staged proposal; reviewed_state must match exactly what was reviewed." });
register({ name: "skill.reject", tier: "local", gate: "none", args: PatternArgs, fn: skillReject, doc: "Reject a staged proposal; delete its branch." });
register({ name: "router.rehome", tier: "local", gate: "none", args: RehomeArgs, fn: routerRehome, doc: "Re-route a pattern to a different artifact type." });
register({ name: "router.retire", tier: "local", gate: "confirm", args: RetireArgs, fn: routerRetire, doc: "Retire an artifact; requires confirm: true." });
register({ name: "router.inventory", tier: "read", gate: "none", args: WorldArgs, fn: routerInventory, doc: "Router state joined with scorecards." });
register({ name: "artifacts.scorecards", tier: "read", gate: "none", args: WorldArgs, fn: artifactsScorecards, doc: "Per-artifact usage scorecards." });
register({ name: "artifacts.rebuild", tier: "local", gate: "none", args: WorldArgs, fn: artifactsRebuild, doc: "Recompute scorecards for a world." });
register({ name: "feedback.add", tier: "local", gate: "none", args: FeedbackArgs, fn: feedbackAdd, doc: "Record a human good/bad vote on an artifact." });
register({ name: "lessons.list", tier: "read", gate: "none", args: WorldArgs, fn: lessonsList, doc: "Inbox lessons for a world." });
register({ name: "logs.tail", tier: "read", gate: "none", args: LogArgs, fn: logsTail, doc: "Last N lines of one engine log." });

// apps/server/src/routes.ts
function buildRoutes() {
  const routes = new Map;
  for (const [name, op] of REGISTRY) {
    routes.set(opPath(name), { name, method: op.tier === "read" ? "GET" : "POST" });
  }
  return routes;
}
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function zodDetail2(err) {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
function mapError(err) {
  if (err instanceof ZodError)
    return jsonResponse(400, { detail: zodDetail2(err) });
  if (err instanceof ValidationError)
    return jsonResponse(400, { detail: err.message });
  if (err instanceof ConfigError)
    return jsonResponse(503, { detail: err.message });
  if (err instanceof ProviderTimeout)
    return jsonResponse(504, { detail: err.message });
  if (err instanceof ProviderError)
    return jsonResponse(502, { detail: err.message });
  if (err instanceof GitError)
    return jsonResponse(502, { detail: (err.stderr || err.message).slice(-2000) });
  if (err instanceof ReviewError)
    return jsonResponse(409, { detail: err.message });
  const e = err instanceof Error ? err : new Error(String(err));
  const trace = e.stack ?? `${e.name}: ${e.message}`;
  appendLine(logFile("web"), `${nowIso()} ERROR ${trace}`);
  return jsonResponse(500, { detail: e.name });
}
async function handleOps() {
  return jsonResponse(200, listOps());
}
async function handleOp(request, route, url) {
  try {
    let payload;
    if (route.method === "GET") {
      payload = Object.fromEntries(url.searchParams.entries());
    } else {
      const raw = await request.text();
      if (!raw) {
        payload = {};
      } else {
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          return jsonResponse(400, { detail: `invalid JSON body: ${e.message}` });
        }
      }
    }
    const result = await invoke(route.name, payload);
    return jsonResponse(200, result);
  } catch (err) {
    return mapError(err);
  }
}

// apps/server/src/static.ts
import { existsSync as existsSync14, statSync as statSync12 } from "fs";
import { join as join23, normalize, sep } from "path";
function staticRoot() {
  return join23(pluginRoot(), "dist", "web");
}
function hasDotSegment(pathname) {
  return pathname.split("/").some((seg) => seg === "." || seg === "..");
}
function resolveStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (hasDotSegment(decoded) || decoded.split("/").some((seg) => seg.startsWith(".")))
    return null;
  const cleaned = decoded.replace(/^\/+/, "");
  const full = normalize(join23(root, cleaned));
  if (full !== root && !full.startsWith(root + sep))
    return null;
  return full;
}
function cacheControl(pathname) {
  return pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store";
}
function fileResponse(path, pathname) {
  return new Response(Bun.file(path), { headers: { "cache-control": cacheControl(pathname) } });
}
async function serveStatic(pathname) {
  const root = staticRoot();
  if (!existsSync14(root))
    return new Response("not found", { status: 404 });
  const wanted = pathname === "/" ? "/index.html" : pathname;
  const target = resolveStaticPath(root, wanted);
  if (target === null)
    return new Response("not found", { status: 404 });
  let st;
  try {
    st = statSync12(target);
  } catch {
    st = null;
  }
  if (st && st.isFile())
    return fileResponse(target, wanted);
  return new Response("not found", { status: 404 });
}

// apps/server/src/token.ts
import { randomBytes } from "crypto";
import { chmodSync as chmodSync2, mkdirSync as mkdirSync8, readFileSync as readFileSync4, writeFileSync as writeFileSync6 } from "fs";
import { dirname as dirname9 } from "path";
function newToken() {
  return randomBytes(32).toString("base64url");
}
function loadOrCreateToken(file = webTokenFile()) {
  try {
    const stored = readFileSync4(file, "utf8").trim();
    if (stored)
      return stored;
  } catch {}
  const token = newToken();
  mkdirSync8(dirname9(file), { recursive: true });
  writeFileSync6(file, token + `
`, { mode: 384 });
  chmodSync2(file, 384);
  return token;
}

// apps/server/src/main.ts
var WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*"]);
var MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
function createServer(opts) {
  const host = opts.host ?? "127.0.0.1";
  if (opts.token === null && !isLoopbackHost(host)) {
    throw new Error(`refusing to bind the web UI to ${JSON.stringify(host)} without a token: drop --no-token or bind 127.0.0.1`);
  }
  const routes = buildRoutes();
  const server = Bun.serve({
    hostname: host,
    port: opts.port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (pathname === "/api/ops" || routes.has(pathname)) {
        const denied = guard(request, { port: server.port ?? opts.port, token: opts.token, allowedHosts: opts.allowedHosts });
        if (denied)
          return denied;
        if (pathname === "/api/ops")
          return handleOps();
        const route = routes.get(pathname);
        if (route.method !== request.method) {
          return new Response(JSON.stringify({ detail: `method not allowed: ${request.method}` }), {
            status: 405,
            headers: { "content-type": "application/json" }
          });
        }
        return handleOp(request, route, url);
      }
      if (pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ detail: "unknown op" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return serveStatic(pathname);
    }
  });
  return server;
}
function urlHost(host) {
  if (WILDCARD_HOSTS.has(host))
    return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}
function privateAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || !isPrivateAddress(addr.address))
        continue;
      out.push(addr.address.includes(":") ? `[${addr.address}]` : addr.address);
    }
  }
  return out;
}
function serve(opts) {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? !isLoopbackHost(host) ? loadOrCreateToken() : null;
  const server = createServer({ port: opts.port, host, token, allowedHosts: opts.allowedHosts });
  const port = server.port ?? opts.port;
  const fragment = token ? `#${token}` : "";
  const hosts = WILDCARD_HOSTS.has(host) ? [urlHost(host), ...privateAddresses()] : [urlHost(host)];
  for (const h of hosts)
    console.log(`http://${h}:${port}/${fragment}`);
  return server;
}
if (false) {}

// apps/cli/src/webUpdate.ts
import { readFileSync as readFileSync5 } from "fs";
import { join as join24, sep as sep2 } from "path";
var PLUGIN_NAME = "self-improvement-loop";
function readText2(file) {
  try {
    return readFileSync5(file, "utf8").trim();
  } catch {
    return "";
  }
}
function isInstalledCopy(root, claudeConfig = claudeConfigDir()) {
  const cache = join24(claudeConfig, "plugins") + sep2;
  return root.startsWith(cache);
}
function installedStamp(claudeConfig = claudeConfigDir()) {
  const raw = readText2(join24(claudeConfig, "plugins", "installed_plugins.json"));
  if (!raw)
    return "";
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return "";
  }
  const plugins = data.plugins ?? {};
  const entries = Object.keys(plugins).filter((key) => key.split("@")[0] === PLUGIN_NAME).flatMap((key) => Array.isArray(plugins[key]) ? plugins[key] : []);
  if (entries.length === 0)
    return "";
  const newest = entries.reduce((a, b) => String(a["lastUpdated"] ?? "") >= String(b["lastUpdated"] ?? "") ? a : b);
  return `${String(newest["installPath"] ?? "")}@${String(newest["lastUpdated"] ?? "")}`;
}
function updateStamp(root = pluginRoot(), claudeConfig = claudeConfigDir()) {
  const build = readText2(join24(root, "dist", ".srchash"));
  const installed = isInstalledCopy(root, claudeConfig) ? installedStamp(claudeConfig) : "";
  return `${build}|${installed}`;
}
function watchForUpdates(onUpdate, opts = {}) {
  const root = opts.root ?? pluginRoot();
  const claudeConfig = opts.claudeConfig ?? claudeConfigDir();
  const baseline = updateStamp(root, claudeConfig);
  let fired = false;
  const timer = setInterval(() => {
    if (fired || updateStamp(root, claudeConfig) === baseline)
      return;
    fired = true;
    clearInterval(timer);
    onUpdate();
  }, opts.intervalMs ?? 5000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// apps/cli/src/commands/web.ts
function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
async function cmdWeb(opts) {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.web.port;
  const host = opts.host ?? cfg.web.host;
  const server = serve({ host, port, token: opts.token, allowedHosts: cfg.web.allowed_hosts });
  if (opts.open)
    openBrowser(`http://${urlHost(host)}:${server.port}/`);
  if (opts.watch ?? true) {
    watchForUpdates(() => {
      console.log("plugin updated: stopping the web UI so the supervisor starts the new version");
      server.stop(false).then(() => process.exit(0));
    });
  }
  return new Promise(() => {});
}

// apps/cli/src/commands/worker.ts
async function cmdWorker(opts, deps = defaultDeps) {
  if (!opts.once && !opts.loop)
    throw new ValidationError("sil worker needs --once or --loop");
  if (opts.once && opts.loop)
    throw new ValidationError("sil worker takes only one of --once or --loop");
  const cfg = loadConfig();
  if (opts.loop) {
    await deps.worker.loop(cfg, opts.intervalS ?? 300);
    return 0;
  }
  const result = await deps.worker.runOnce(cfg, {
    worldName: opts.world,
    reflect: true,
    curriculum: !opts.noCurriculum
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

// apps/cli/src/commands/worlds.ts
function cmdWorldsList() {
  const cfg = loadConfig();
  if (cfg.worlds.length === 0) {
    console.log("no worlds configured");
    return 0;
  }
  for (const w of cfg.worlds) {
    const repos = w.repos.join(", ") || "(catch-all)";
    const target = w.target || "(learned/)";
    console.log(`${w.name.padEnd(16)} llm=${w.llm.padEnd(6)} remote=${w.remote.padEnd(5)} target=${target}  repos=${repos}`);
  }
  return 0;
}
function cmdWorldsAdd(name, opts) {
  const cfg = loadConfig();
  if (cfg.worlds.some((w) => w.name === name)) {
    throw new ConfigError(`world ${JSON.stringify(name)} already exists`);
  }
  const layout = opts.layout === "v1" ? Layout.parse(V1_LAYOUT) : Layout.parse({});
  const world = World.parse({
    name,
    llm: opts.llm || "cloud",
    repos: (opts.repos ?? []).map((p) => expandHome(p)),
    target: opts.target ? expandHome(opts.target) : null,
    layout
  });
  cfg.worlds.push(world);
  saveConfig(cfg);
  writeHookSnapshot(cfg);
  console.log(`added world ${name} (layout: ${opts.layout || "default"})`);
  return 0;
}
function cmdWorldsImportKb(path) {
  const cfg = loadConfig();
  const imported = importKbWorlds(path);
  const added = mergeWorlds(cfg, imported);
  saveConfig(cfg);
  writeHookSnapshot(cfg);
  console.log(`read ${imported.length} world(s) from ${path}, added ${added} new`);
  return 0;
}

// apps/cli/src/main.ts
var intOption = (v) => parseInt(v, 10);
function buildProgram(deps, onExit, onRun) {
  const program = new Command;
  program.name("sil").description("self-improvement-loop engine").exitOverride();
  const wire = (fn) => {
    return async (...args) => {
      onRun();
      onExit(await fn(...args));
    };
  };
  program.command("init").option("--world <name>").option("--target <path>").option("--llm-base-url <url>").option("--api-key-env <name>").option("--model <name>").option("--claude-model <name>").action(wire((opts) => cmdInit(opts)));
  program.command("status").option("--json").action(wire((opts) => cmdStatus(opts, deps)));
  program.command("reflect").option("--session <id>").option("--cwd <path>").option("--now").action(wire((opts) => cmdReflect(opts, deps)));
  program.command("worker").option("--once").option("--loop").option("--interval-s <n>", "seconds between loop passes", intOption).option("--world <name>").option("--no-curriculum").action(wire((opts) => {
    const { curriculum, ...rest } = opts;
    return cmdWorker({ ...rest, noCurriculum: curriculum === false }, deps);
  }));
  const curriculum = program.command("curriculum");
  curriculum.command("plan").option("--world <name>").option("--json").action(wire((opts) => cmdCurriculumPlan(opts, deps)));
  curriculum.command("run").option("--world <name>").option("--apply").option("--json").action(wire((opts) => cmdCurriculumRun(opts, deps)));
  const review = program.command("review");
  review.command("list").option("--world <name>").action(wire((opts) => cmdReviewList(opts, deps)));
  review.command("show").argument("<pattern>").option("--world <name>").option("--diff").action(wire((pattern, opts) => cmdReviewShow(pattern, opts, deps)));
  review.command("accept").argument("<pattern>").requiredOption("--world <name>").requiredOption("--reviewed-state <hash>").action(wire((pattern, opts) => cmdReviewAccept(pattern, opts, deps)));
  review.command("reject").argument("<pattern>").requiredOption("--world <name>").action(wire((pattern, opts) => cmdReviewReject(pattern, opts, deps)));
  review.command("rehome").argument("<pattern>").requiredOption("--type <type>").requiredOption("--world <name>").action(wire((pattern, opts) => cmdReviewRehome(pattern, opts, deps)));
  review.command("retire").argument("<pattern>").requiredOption("--world <name>").option("--yes").action(wire((pattern, opts) => cmdReviewRetire(pattern, opts, deps)));
  const reflections = program.command("reflections");
  reflections.command("list").option("--world <name>").option("--pattern <pattern>").option("--limit <n>", "", intOption).action(wire((opts) => cmdReflectionsList(opts)));
  reflections.command("show").argument("<id>").requiredOption("--world <name>").action(wire((id, opts) => cmdReflectionsShow(id, opts)));
  const aliases = program.command("aliases");
  aliases.command("list").option("--world <name>").action(wire((opts) => cmdAliasesList(opts)));
  aliases.command("set").argument("<alias>").argument("<canonical>").option("--world <name>").action(wire((alias, canonical, opts) => cmdAliasesSet(alias, canonical, opts)));
  aliases.command("rm").argument("<alias>").option("--world <name>").action(wire((alias, opts) => cmdAliasesRm(alias, opts)));
  aliases.command("suggest").option("--world <name>").action(wire((opts) => cmdAliasesSuggest(opts)));
  program.command("artifacts").argument("[action]").option("--world <name>").option("--json").action(wire((action, opts) => cmdArtifacts({ ...opts, action }, deps)));
  const feedback = program.command("feedback");
  feedback.command("add").argument("<ref>").argument("<vote>").option("--note <text>").option("--world <name>").action(wire((ref, vote, opts) => {
    if (vote !== "good" && vote !== "bad")
      throw new ValidationError("vote must be good or bad");
    return cmdFeedbackAdd(ref, vote, opts, deps);
  }));
  feedback.command("list").action(wire(() => cmdFeedbackList(deps)));
  program.command("lessons").option("--world <name>").action(wire((opts) => cmdLessons(opts)));
  const llm = program.command("llm");
  llm.command("list").option("--json").option("--world <name>").action(wire((opts) => cmdLlmList(opts, deps)));
  llm.command("use").argument("<endpoint>").option("--role <role>", "critic, drafter or judge; omit to switch every role").action(wire((endpoint, opts) => cmdLlmUse(endpoint, opts)));
  llm.command("set-model").argument("<role>").argument("<model>").option("--endpoint <name>", "defaults to the endpoint that currently serves the role").action(wire((role, model, opts) => cmdLlmSetModel(role, model, opts)));
  program.command("web").option("--port <n>", "", intOption).option("--token", "force a URL token (default: on only for non-loopback binds)").option("--no-token", "force tokenless (loopback only)").option("--open").option("--host <host>", "bind address; defaults to config web.host (127.0.0.1). Use a LAN or tailscale address, or 0.0.0.0, to reach it from another machine").option("--no-watch", "keep running after a plugin update instead of exiting for the supervisor to restart").action(wire((opts) => cmdWeb(opts)));
  const worlds = program.command("worlds");
  worlds.command("list").action(wire(() => cmdWorldsList()));
  worlds.command("add").argument("<name>").option("--repos <repos...>").option("--target <path>").option("--llm <llm>").option("--layout <layout>", "", "default").action(wire((name, opts) => cmdWorldsAdd(name, opts)));
  worlds.command("import-kb").argument("<path>").action(wire((path) => cmdWorldsImportKb(path)));
  const imp = program.command("import");
  imp.command("reflections").argument("<dir>").requiredOption("--world <name>").action(wire((dir, opts) => cmdImportReflections(dir, opts)));
  imp.command("ledger").argument("<file>").requiredOption("--world <name>").action(wire((file, opts) => cmdImportLedger(file, opts)));
  const sched = program.command("schedule");
  sched.command("install").option("--systemd").option("--launchd").option("--web").option("--interval-min <n>", "", intOption).action(wire((opts) => cmdScheduleInstall(opts)));
  sched.command("uninstall").action(wire(() => cmdScheduleUninstall()));
  sched.command("show").action(wire(() => cmdScheduleShow()));
  program.command("logs").argument("<name>").option("--lines <n>", "", intOption).action(wire((name, opts) => cmdLogs(name, opts)));
  program.command("hook-snapshot").action(wire(() => cmdHookSnapshot()));
  return program;
}
async function run2(argv, deps = defaultDeps) {
  let exitCode = 0;
  let ran = false;
  const program = buildProgram(deps, (n) => {
    exitCode = n;
  }, () => {
    ran = true;
  });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    const mapped = mapKnownError(err);
    if (mapped !== null)
      return mapped;
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return 1;
  }
  if (!ran) {
    program.outputHelp();
    return 1;
  }
  return exitCode;
}
if (import.meta.main) {
  const code = await run2(process.argv.slice(2));
  process.exit(code);
}
export {
  run2 as run
};
