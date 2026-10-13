import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { PARTICIPANT_ID } from '../auth/auth.service.js'
import { ModeratorGuard, ParticipantGuard } from '../auth/auth.guards.js'
import { VotingService } from './voting.service.js'
import {
  CreateAssemblyDto,
  CompleteAssemblyDto,
  CreateRoundDto,
  CommitteeApprovalDto,
  CommitteeConfigurationUpdateDto,
  CommitteeProposalDto,
  CommitteeStageDto,
  JoinAssemblyDto,
  LobbyPatchDto,
  ParticipantPatchDto,
  OfficialResultDto,
  VoteDto,
} from './dtos.js'

type SessionRequest = Request & { [PARTICIPANT_ID]?: string }

function sessionId(request: SessionRequest): string {
  if (!request[PARTICIPANT_ID]) throw new Error('Participant guard did not attach the session identity')
  return request[PARTICIPANT_ID]
}

@Controller('assemblies')
export class PublicAssemblyController {
  constructor(private readonly voting: VotingService) {}

  @Post(':assemblyCode/join')
  join(@Param('assemblyCode') assemblyCode: string, @Body() input: JoinAssemblyDto) {
    return this.voting.joinAssembly(assemblyCode, input.firstName, input.lastName)
  }

  @Get(':assemblyCode/public-state')
  publicState(@Param('assemblyCode') assemblyCode: string) {
    return this.voting.publicState(assemblyCode)
  }
}

@Controller('participant')
@UseGuards(ParticipantGuard)
export class ParticipantController {
  constructor(private readonly voting: VotingService) {}

  @Get('me')
  me(@Req() request: SessionRequest) {
    return this.voting.participantState(sessionId(request))
  }

  @Post('rounds/:roundId/vote')
  vote(@Req() request: SessionRequest, @Param('roundId', ParseUUIDPipe) roundId: string, @Body() input: VoteDto) {
    return this.voting.castVote(sessionId(request), roundId, input.optionIds ?? input.optionId ?? '')
  }

  @Post('rounds/:roundId/committee/proposals')
  propose(@Req() request: SessionRequest, @Param('roundId', ParseUUIDPipe) roundId: string, @Body() input: CommitteeProposalDto) {
    return this.voting.submitCommitteeProposal(sessionId(request), roundId, input.candidateParticipantId)
  }

  @Post('rounds/:roundId/committee/proposals/:proposalId/support')
  support(@Req() request: SessionRequest, @Param('roundId', ParseUUIDPipe) roundId: string, @Param('proposalId', ParseUUIDPipe) proposalId: string) {
    return this.voting.supportCommitteeProposal(sessionId(request), roundId, proposalId)
  }
}

@Controller('moderator')
@UseGuards(ModeratorGuard)
export class ModeratorController {
  constructor(private readonly voting: VotingService) {}

  @Get('session')
  session() {
    return { authenticated: true }
  }

  @Post('assemblies')
  createAssembly(@Body() input: CreateAssemblyDto) {
    return this.voting.createAssembly(input.name)
  }

  @Get('assemblies/:assemblyId')
  assembly(@Param('assemblyId', ParseUUIDPipe) assemblyId: string) {
    return this.voting.moderatorAssembly(assemblyId)
  }

  @Patch('assemblies/:assemblyId/lobby')
  lobby(@Param('assemblyId', ParseUUIDPipe) assemblyId: string, @Body() input: LobbyPatchDto) {
    return this.voting.changeLobby(assemblyId, input.status)
  }

  @Post('assemblies/:assemblyId/complete')
  completeAssembly(@Param('assemblyId', ParseUUIDPipe) assemblyId: string, @Body() input: CompleteAssemblyDto) {
    return this.voting.completeAssembly(assemblyId, input.confirmation)
  }

  @Patch('participants/:participantId')
  participant(@Param('participantId', ParseUUIDPipe) participantId: string, @Body() input: ParticipantPatchDto) {
    return this.voting.patchParticipant(participantId, input)
  }

  @Post('assemblies/:assemblyId/rounds')
  createRound(@Param('assemblyId', ParseUUIDPipe) assemblyId: string, @Body() input: CreateRoundDto) {
    return this.voting.createRound(assemblyId, input)
  }

  @Post('rounds/:roundId/open')
  openRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.voting.openRound(roundId)
  }

  @Post('rounds/:roundId/close')
  closeRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.voting.closeRound(roundId)
  }

  @Post('rounds/:roundId/publish')
  publishRound(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.voting.publishRound(roundId)
  }

  @Post('rounds/:roundId/committee/stage')
  committeeStage(@Param('roundId', ParseUUIDPipe) roundId: string, @Body() input: CommitteeStageDto) {
    return this.voting.advanceCommitteeStage(roundId, input.stage)
  }

  @Patch('rounds/:roundId/committee/configuration')
  committeeConfiguration(@Param('roundId', ParseUUIDPipe) roundId: string, @Body() input: CommitteeConfigurationUpdateDto) {
    return this.voting.updateCommitteeConfiguration(roundId, input)
  }

  @Put('rounds/:roundId/committee/proposals/:proposalId/approval')
  committeeApproval(@Param('roundId', ParseUUIDPipe) roundId: string, @Param('proposalId', ParseUUIDPipe) proposalId: string, @Body() input: CommitteeApprovalDto) {
    return this.voting.recordCommitteeApproval(roundId, proposalId, input)
  }

  @Put('rounds/:roundId/official-result')
  officialResult(@Param('roundId', ParseUUIDPipe) roundId: string, @Body() input: OfficialResultDto) {
    return this.voting.declareOfficialResult(roundId, input)
  }

  @Post('rounds/:roundId/official-result/publish')
  publishOfficialResult(@Param('roundId', ParseUUIDPipe) roundId: string) {
    return this.voting.publishOfficialResult(roundId)
  }
}
