import { App, Duration, Stack } from 'aws-cdk-lib/core';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Schedule } from 'aws-cdk-lib/aws-applicationautoscaling';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

import { vpcFromConfig } from '../utils';

import { BaseNodeJsProps, EventType, LogGroupSubscriberLambdaArnType } from './types';
import { BaseNodeJsFunction } from './lambda-base';

describe('lambda-base', () => {
  it('basic instantiation', async () => {
    const app = new App();
    const stack = new Stack(app);

    const vpc = vpcFromConfig(stack, {
      vpcId: 'aaa',
      availabilityZones: ['a'],
      privateSubnetIds: ['a'],
      privateSubnetRouteTableIds: ['a'],
    });

    const customSG = new SecurityGroup(stack, 'customsg', {
      vpc,
      description: 'custom sg',
      allowAllOutbound: false,
    });
    customSG.addIngressRule(Peer.ipv4('9.9.9.9/32'), Port.allTraffic(), 'allow ingress');
    customSG.addEgressRule(Peer.ipv4('8.8.8.8/32'), Port.allTraffic(), 'allow egress');
    customSG.addEgressRule(Peer.ipv4('1.2.3.4/32'), Port.tcp(8888), 'Sample egress rule');

    const lambdaConfig: BaseNodeJsProps = {
      stage: 'dev',
      network: {
        vpcId: 'aaa',
        availabilityZones: ['a'],
        privateSubnetIds: ['a'],
        privateSubnetRouteTableIds: ['a'],
      },
      eventType: EventType.Http,
      baseCodePath: 'src/apigateway/__tests__',
      // allowAllOutbound: true,
      extraCaPubCert: 'CERTIFICATE CONTENTS!',
      provisionedConcurrentExecutions: {
        minCapacity: 3,
      },
      logGroupRetention: RetentionDays.FIVE_DAYS,
      securityGroups: [customSG],
    };

    if (!lambdaConfig.network) throw new Error('lambdaConfig.network should be defined');
    if (!vpc) throw new Error('vpc should be defined');

    lambdaConfig.logGroupSubscriberLambdaArn = {
      type: LogGroupSubscriberLambdaArnType.Arn,
      value: 'arn:aws:lambda:eu-west-1:012345678:function:tstLogging',
    };

    const func = new BaseNodeJsFunction(stack, 'test-lambda', lambdaConfig);
    expect(func).toBeDefined();
    expect(func.nodeJsFunction.runtime).toBe(Runtime.NODEJS_20_X);
    expect(func.nodeJsFunction.node.id).toBe('test-lambda');
    expect(func.nodeJsFunction.functionName).toEqual(expect.stringContaining('${Token'));

    // execute synth and test results
    const template = Template.fromStack(stack);
    // console.log(JSON.stringify(template.toJSON(), null, 2));

    template.hasResourceProperties('AWS::Lambda::Function', {
      Code: {
        S3Bucket: {
          // eslint-disable-next-line no-template-curly-in-string
          'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
        },
      },
      Environment: {
        Variables: {
          STAGE: 'dev',
          NODE_EXTRA_CA_CERTS: '/var/task/extra-ca.pub',
        },
      },
      Handler: 'index.handler',
      Runtime: `${Runtime.NODEJS_20_X}`,
    });

    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      ProvisionedConcurrencyConfig: {
        ProvisionedConcurrentExecutions: 3,
      },
    });

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      // LogGroupName: '/aws/lambda/test-lambda-dev',
      RetentionInDays: 5,
    });

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'custom sg',
      SecurityGroupIngress: [{ CidrIp: '9.9.9.9/32' }],
      SecurityGroupEgress: [
        { CidrIp: '8.8.8.8/32' },
        { CidrIp: '1.2.3.4/32', FromPort: 8888, IpProtocol: 'tcp' },
      ],
    });

    template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
      DestinationArn: 'arn:aws:lambda:eu-west-1:012345678:function:tstLogging',
      LogGroupName: {
        Ref: 'testlambdadefaultloggroup43FBE067',
      },
      FilterName: 'all',
      FilterPattern: '',
    });

    template.resourcePropertiesCountIs(
      'AWS::Lambda::Permission',
      {
        FunctionName: 'arn:aws:lambda:eu-west-1:012345678:function:tstLogging',
        Action: 'lambda:InvokeFunction',
        Principal: 'logs.eu-west-1.amazonaws.com',
      },
      0,
    );
  });

  it('should allow ssm log group subscriptions', async () => {
    const app = new App();
    const stack = new Stack(app);

    const lambdaConfig: BaseNodeJsProps = {
      stage: 'dev',
      eventType: EventType.Http,
      baseCodePath: 'src/apigateway/__tests__',
      logGroupSubscriberLambdaArn: {
        type: LogGroupSubscriberLambdaArnType.Ssm,
        value: 'log-forwarder-lambda-arn',
      },
    };

    // eslint-disable-next-line no-new
    new StringParameter(stack, 'log-forwarder-lambda', {
      parameterName: 'log-forwarder-lambda-arn',
      description: 'Cloudwatch log forwarder Lambda ARN',
      stringValue: 'arn:aws:lambda:eu-west-1:012345678:function:tstLoggerForwarder',
    });

    const func = new BaseNodeJsFunction(stack, 'test-lambda', lambdaConfig);
    expect(func).toBeDefined();

    // execute synth and test results
    const template = Template.fromStack(stack);
    // console.log(JSON.stringify(template.toJSON(), null, 2));

    template.hasResourceProperties('AWS::Logs::SubscriptionFilter', {
      DestinationArn: {
        Ref: 'SsmParameterValuelogforwarderlambdaarnC96584B6F00A464EAD1953AFF4B05118Parameter',
      },
      LogGroupName: {
        Ref: 'testlambdadefaultloggroup43FBE067',
      },
      FilterName: 'all',
      FilterPattern: '',
    });
  });

  it('no vpc declaration', async () => {
    const app = new App();
    const stack = new Stack(app);

    const f = (): void => {
      // eslint-disable-next-line no-new
      new BaseNodeJsFunction(stack, 'test-lambda1', {
        stage: 'dev',
        eventType: EventType.Http,
        baseCodePath: 'src/lambda/__tests__',
        // allowOutboundTo: [{ peer: Peer.ipv4('0.0.0.0/0'), port: Port.tcp(443) }],
      });
    };
    expect(f).toThrow();

    const func = new BaseNodeJsFunction(stack, 'test-lambda2', {
      stage: 'dev',
      entry: 'src/lambda/__tests__/http/test-lambda/index.ts',
    });

    expect(func.nodeJsFunction.isBoundToVpc).toBe(false);

    const f2 = (): void => {
      // eslint-disable-next-line no-new
      new BaseNodeJsFunction(stack, 'test-lambda', {
        stage: 'dev',
        baseCodePath: 'src/lambda/__tests__',
      });
    };
    expect(f2).toThrow(`'eventType' is required if 'entry' is not defined`);

    expect(func.nodeJsFunction.isBoundToVpc).toBe(false);

    // execute synth and test results
    const template = Template.fromStack(stack);
    // console.log(JSON.stringify(template.toJSON(), null, 2));
    template.hasResourceProperties('AWS::Lambda::Function', {});
  });

  it('advanced instantiation', async () => {
    const app = new App();
    const stack = new Stack(app);

    const lambdaConfig: BaseNodeJsProps = {
      stage: 'dev-pr-123',
      network: {
        vpcId: 'aaa',
        availabilityZones: ['a'],
        privateSubnetIds: ['a'],
        privateSubnetRouteTableIds: ['a'],
      },
      timeout: Duration.seconds(200),
      eventType: EventType.Http,
      entry: 'src/lambda/__tests__/http/test-lambda/index.ts',
      reservedConcurrentExecutions: 10,
      environment: {
        TEST1: 'VALUE1',
      },
      bundling: {
        sourceMap: true,
      },
      provisionedConcurrentExecutions: {
        minCapacity: 4,
        maxCapacity: 9,
        schedules: [
          {
            minCapacity: 0,
            maxCapacity: 3,
            schedule: Schedule.cron({ minute: '*/2' }),
            name: 'Run each other minute',
          },
          {
            minCapacity: 3,
            maxCapacity: 8,
            schedule: Schedule.rate(Duration.days(1)),
          },
        ],
      },
    };

    const func = new BaseNodeJsFunction(stack, 'test-lambda', lambdaConfig);

    // The CDK will add stackname prefix to it if the function name is undefined
    expect(func.nodeJsFunction.node.id).toBe('test-lambda');
    expect(func.nodeJsFunction.functionName).toEqual(expect.stringContaining('${Token'));

    // execute synth and test results
    const template = Template.fromStack(stack);
    // console.log(JSON.stringify(template.toJSON(), null, 2));

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      ReservedConcurrentExecutions: 10,
      Environment: {
        Variables: {
          STAGE: 'dev-pr-123',
          NODE_OPTIONS: '--enable-source-maps',
          TEST1: 'VALUE1',
        },
      },
    });

    template.hasResource('AWS::Lambda::Version', {});

    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      ProvisionedConcurrencyConfig: {
        ProvisionedConcurrentExecutions: 4,
      },
    });

    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 4,
      MaxCapacity: 9,
      ScalableDimension: 'lambda:function:ProvisionedConcurrency',
      ScheduledActions: [
        {
          ScalableTargetAction: {
            MinCapacity: 0,
            MaxCapacity: 3,
          },
          Schedule: 'cron(*/2 * * * ? *)',
          ScheduledActionName: 'Run each other minute',
        },
        {
          ScalableTargetAction: {
            MinCapacity: 3,
            MaxCapacity: 8,
          },
          Schedule: 'rate(1 day)',
        },
      ],
    });
  });
});
