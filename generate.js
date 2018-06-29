var acorn = require("acorn");
var walk = require("acorn/dist/walk");
var assert = require("assert");
var yaml = require("js-yaml");

var fs = require("fs");

var contents = fs.readFileSync("test.js");

var ast = acorn.parse(contents.toString(), { ecmaVersion: 8, sourceType: "module" });

function minIndent(str) {
  const match = str.match(/^[ \t]*(?=\S)/gm);

  if (!match) {
    return 0;
  }

  return Math.min.apply(Math, match.map(x => x.length));
}

function stripIndent(str) {
  const indent = minIndent(str);

  if (indent === 0) {
    return str;
  }

  const re = new RegExp(`^[ \\t]{${indent}}`, 'gm');

  return str.replace(re, '');
}

function findDescribeNode(node) {
  var describeNodes = [];

  walk.ancestor(ast, {
    Identifier: function(node, ancestors) {
      if (node.name == "describe") {
        describeNodes.push({ node: node, ancestors: ancestors.slice(0, -1).reverse() });
      }
    }
  });

  return describeNodes;
}

function findPossibleErrors(node) {
  var possibleErrors = [];

  walk.simple(ast, {
    FunctionDeclaration: function(node) {
      var functionArguments = node.params.map(function(param) { return param.name; });
      var functionName = node.id.name;

      if (functionArguments.includes("line") && functionArguments.includes("column")) {
        possibleErrors[functionName] = {
          name: functionName,
          arguments: functionArguments,
        };
      }
    }
  });

  return possibleErrors;
}

var possibleErrors = findPossibleErrors(ast);
var describeNode = findDescribeNode(ast)[0];
var itNodes = [];

walk.ancestor(describeNode.ancestors[0], {
  Identifier: function(node, ancestors) {
    if (node.name == "it") {
      var itNode = { node: node, ancestors: ancestors.slice(0, -1).reverse() };

      itNodes.push(itNode);
    }
  }
});

function findAssertionCallNode(node) {
  var assertionNode;

  walk.ancestor(node, {
    Identifier: function(node, ancestors) {
      if (node.name == "expectFailsRule" || node.name == "expectPassesRule") {
        assertionNode = ancestors[ancestors.length - 2];
      }
    }
  });

  return assertionNode;
}

function expectedErrorsFromNodes(nodes) {
  return nodes.map(function(node) {
    assert.equal(node.type, "CallExpression");

    var errorCode = node.callee.name;
    var functionArguments = possibleErrors[errorCode].arguments;
    var errorLoc = {};
    var errorArguments = {};

    node.arguments.forEach(function(argument, index) {
      var argumentName = functionArguments[index];
      if (argumentName == "line" || argumentName == "column") {
        errorLoc[argumentName] = argument.value;
      } else if (argument.type == "Literal") {
        errorArguments[argumentName] = argument.value;
      } else if (argument.type == "ArrayExpression") {
        errorArguments[argumentName] = argument.elements.map(function(value) { return value.value; });
      }
    });

    var error = {
      "error-code": errorCode,
      args: errorArguments,
      loc: errorLoc,
    };

    return error;
  });
}

var tests = itNodes.map(function(node) {
  var testNameNode = node.ancestors[0].arguments[0];
  assert.equal(testNameNode.type, "Literal");

  var testFunctionNode = node.ancestors[0].arguments[1];
  assert.equal(testFunctionNode.type, "ArrowFunctionExpression");

  var assertionCallNode = findAssertionCallNode(testFunctionNode);
  if (!assertionCallNode) {
    console.log("Skipping " + testNameNode.value);
    return;
    assert(assertionCallNode);
  }

  var validationRuleNameNode = assertionCallNode.arguments[0];
  assert.equal(validationRuleNameNode.type, "Identifier");

  var validationRuleQueryNode = assertionCallNode.arguments[1];
  assert.equal(validationRuleQueryNode.type, "TemplateLiteral");

  var expectedErrors;

  if (assertionCallNode.callee.name == "expectFailsRule") {
    var expectedErrorsNode = assertionCallNode.arguments[2];
    assert.equal(expectedErrorsNode.type, "ArrayExpression");

    expectedErrors = expectedErrorsFromNodes(expectedErrorsNode.elements);
  }

  return {
    name: testNameNode.value,
    rule: validationRuleNameNode.name,
    query: validationRuleQueryNode.quasis[0].value.raw,
    expectedErrors: expectedErrors,
  };
}).filter(function(test) { return !!test; });

var scenario = {};

scenario.scenario = describeNode.ancestors[0].arguments[0].value;
scenario.background = { "schema-file": "validation.schema.graphql" };
scenario.tests = tests.map(function(test) {
  var indentValue = minIndent(test.query);

  var scenarioTest = {
    name: test.name,
    given: {
      query: stripIndent(test.query)
    },
    when: {
      validate: [
        test.rule
      ]
    },
  };

  if (test.expectedErrors) {
    scenarioTest.then = test.expectedErrors.map(function(error) {
      error.loc.column = error.loc.column - indentValue;

      return error;
    });

    scenarioTest.then.unshift({ "error-count": test.expectedErrors.length  });
  } else {
    scenarioTest.then = { passes: true };
  }

  return scenarioTest;
});

console.log(yaml.safeDump(scenario));
